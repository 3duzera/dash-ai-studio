"""Gera os dados falsos (determinístico: mesma seed, mesmos dados).

Uso:  python seed.py            # aplica as migrações e só popula se o banco estiver vazio
      python seed.py --reset    # apaga tudo (inclusive dashboards) e gera de novo

O dado é de duas lojas online fictícias, 90 dias de pedidos. O que está plantado de propósito, para os
dashboards terem o que mostrar (e os testes terem o que conferir):
  - 2 dias sem carga (daily_load = failed): buracos nos gráficos de linha
  - Rio Grande do Sul com pouco pedido e muito mais atraso na entrega
  - Marketplace com mais cancelamento, mais desconto e margem menor
  - Clube de assinantes compra com mais frequência (recompra alta), sobretudo pelo App
  - uma categoria com devolução bem acima das outras
  - uma semana de promoção numa categoria por volta do dia 45 (desconto alto, volume alto)
  - uma categoria caindo forte na última semana (variação de 7 dias negativa)
  - crescimento leve ao longo dos 90 dias e fim de semana mais forte
"""
import os
import random
import sys
import unicodedata
from datetime import date, datetime, time, timedelta, timezone

import psycopg

SEED = 42
DAYS = 90
END = date.today() - timedelta(days=1)
START = END - timedelta(days=DAYS - 1)
GAP_DAYS = {20, 61}          # índice do dia sem carga
PROMO_DAYS = range(45, 52)   # semana de promoção da categoria marcada
FALL_FROM = DAYS - 7         # a categoria marcada cai nos últimos 7 dias

# (id, nome, peso no volume de pedidos)
STATES = [
    ("sp", "São Paulo", 0.36), ("rj", "Rio de Janeiro", 0.17), ("mg", "Minas Gerais", 0.15),
    ("pr", "Paraná", 0.12), ("ba", "Bahia", 0.13), ("rs", "Rio Grande do Sul", 0.07),
]
CHANNELS = [
    ("site", "Site", 0.36), ("app", "App", 0.22), ("marketplace", "Marketplace", 0.25),
    ("loja", "Loja física", 0.12), ("social", "Redes sociais", 0.05),
]
SEGMENTS = [("varejo", "Pessoa física", 0.75), ("empresa", "Empresas", 0.10), ("clube", "Clube de assinantes", 0.15)]

LATE = {"sp": 0.05, "rj": 0.08, "mg": 0.07, "pr": 0.06, "ba": 0.12, "rs": 0.30}
CANCEL = {"site": 0.03, "app": 0.02, "marketplace": 0.09, "loja": 0.01, "social": 0.05}
CHANNEL_PRICE = {"site": 1.00, "app": 0.99, "marketplace": 0.93, "loja": 1.03, "social": 1.00}
CHANNEL_DISCOUNT = {"site": 0.00, "app": 0.02, "marketplace": 0.06, "loja": 0.00, "social": 0.03}
FREQUENCY = {"varejo": 1.0, "empresa": 2.5, "clube": 5.0}   # peso de cada cliente no sorteio dos pedidos

TENANTS = [
    {
        "id": "aurora", "name": "Aurora Casa", "segment": "Casa e cozinha",
        "modules": ["sales", "customers", "operations"],
        "orders_per_day": 420, "customers": 30000, "prefix": "A",
        "promo": "eletro", "falling": "climatizacao", "returns": "cama_banho",
        "categories": [
            ("cozinha", "Cozinha", 160, 1.0, ["Jogo de Panelas 5 peças", "Frigideira Antiaderente 28cm", "Conjunto de Facas",
                                              "Kit Potes Herméticos", "Tábua de Corte Bambu", "Garrafa Térmica 1L"]),
            ("eletro", "Eletroportáteis", 340, 0.8, ["Air Fryer 4L", "Liquidificador 3L", "Cafeteira Elétrica",
                                                    "Batedeira Planetária", "Sanduicheira", "Chaleira Elétrica"]),
            ("cama_banho", "Cama e banho", 130, 0.9, ["Jogo de Lençol Casal", "Edredom Queen", "Toalha de Banho Kit 4",
                                                     "Travesseiro Viscoelástico", "Cobertor Microfibra", "Roupão Algodão"]),
            ("decoracao", "Decoração", 85, 0.7, ["Vaso Cerâmica", "Quadro Decorativo", "Luminária de Mesa",
                                                "Espelho Redondo", "Kit Almofadas", "Porta-retratos"]),
            ("climatizacao", "Climatização", 420, 0.6, ["Ventilador de Coluna", "Ventilador de Mesa", "Climatizador 8L",
                                                       "Umidificador", "Ar-condicionado Portátil", "Circulador de Ar"]),
        ],
    },
    {
        "id": "brisa", "name": "Brisa Beleza", "segment": "Beleza e cuidados",
        "modules": ["sales", "customers"],                 # sem Operação: testa o catálogo filtrado
        "orders_per_day": 300, "customers": 22000, "prefix": "B",
        "promo": "perfumaria", "falling": "protecao_solar", "returns": "maquiagem",
        "categories": [
            ("cabelo", "Cabelo", 42, 1.0, ["Shampoo Hidratação", "Condicionador Reparador", "Máscara Capilar",
                                         "Óleo Capilar", "Leave-in Cachos", "Shampoo Antiqueda"]),
            ("corpo", "Corpo", 55, 0.9, ["Hidratante Corporal", "Sabonete Líquido", "Esfoliante",
                                        "Óleo Corporal", "Desodorante Roll-on", "Creme para Mãos"]),
            ("perfumaria", "Perfumaria", 190, 0.6, ["Perfume Floral", "Perfume Amadeirado", "Body Splash",
                                                   "Perfume Cítrico", "Colônia Infantil", "Kit Miniaturas"]),
            ("protecao_solar", "Proteção solar", 75, 0.8, ["Protetor FPS 30", "Protetor FPS 50", "Protetor Facial FPS 60",
                                                          "Protetor Infantil", "Protetor Spray", "Pós-sol"]),
            ("maquiagem", "Maquiagem", 80, 0.9, ["Base Líquida", "Batom Matte", "Máscara de Cílios",
                                                "Pó Compacto", "Corretivo", "Paleta de Sombras"]),
        ],
    },
]

COLS = ("tenant_id", "day", "order_id", "customer_id", "product_id", "channel_id", "state_id", "segment_id",
        "qty", "unit_price", "discount", "status", "late", "first_order")


def slug(text: str) -> str:
    t = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode().lower()
    out, dash = [], False
    for ch in t:
        if ch.isalnum():
            out.append(ch)
            dash = False
        elif not dash:
            out.append("-")
            dash = True
    return "".join(out).strip("-")


def pick(rng, items):
    """Sorteia o id de uma lista (id, nome, peso)."""
    return rng.choices([i[0] for i in items], weights=[i[2] for i in items])[0]


def build_catalog(rng, t):
    products = []
    for cat, cat_name, base, _w, names in t["categories"]:
        for n in names:
            price = round(base * rng.uniform(0.7, 1.4), 2)
            products.append({"id": slug(n), "name": n, "category": cat, "category_name": cat_name,
                             "price": price, "cost": round(price * rng.uniform(0.45, 0.62), 2),
                             "pop": rng.uniform(0.5, 1.5)})
    return products


def build_customers(rng, t):
    out = []
    for i in range(t["customers"]):
        seg = pick(rng, SEGMENTS)
        # Clube prefere o App; empresas, o site.
        if seg == "clube" and rng.random() < 0.6:
            ch = "app"
        elif seg == "empresa" and rng.random() < 0.5:
            ch = "site"
        else:
            ch = pick(rng, CHANNELS)
        out.append({"id": f"{t['prefix']}C{i:05d}", "segment": seg, "state": pick(rng, STATES), "channel": ch,
                    "weight": FREQUENCY[seg] * (1.6 if ch == "app" else 1.0),
                    "seen": rng.random() < 0.5})   # metade já comprou antes da janela
    return out


def category_weights(t, d):
    w = {}
    for cat, _n, _b, weight, _names in t["categories"]:
        if cat == t["promo"] and d in PROMO_DAYS:
            weight *= 3.0
        if cat == t["falling"] and d >= FALL_FROM:
            weight *= 0.45
        w[cat] = weight
    return w


def generate(rng, t, products, customers):
    by_cat = {}
    for p in products:
        by_cat.setdefault(p["category"], []).append(p)
    cum, acc = [], 0.0
    for c in customers:
        acc += c["weight"]
        cum.append(acc)
    seq = 0
    for d in range(DAYS):
        if d in GAP_DAYS:
            continue
        day = START + timedelta(days=d)
        volume = t["orders_per_day"] * (1 + 0.2 * d / (DAYS - 1)) * rng.uniform(0.92, 1.08)
        if day.weekday() >= 5:
            volume *= 1.15
        if d in PROMO_DAYS:
            volume *= 1.25
        cw = category_weights(t, d)
        cats, weights = list(cw), list(cw.values())
        for c in rng.choices(customers, cum_weights=cum, k=int(volume)):
            seq += 1
            order_id = f"{t['prefix']}{seq:07d}"
            channel = c["channel"] if rng.random() < 0.8 else pick(rng, CHANNELS)
            canceled = rng.random() < CANCEL[channel]
            late = not canceled and rng.random() < LATE[c["state"]]
            first = not c["seen"]
            c["seen"] = True
            n_lines = 1 + (rng.random() < 0.4) + (rng.random() < 0.15)
            for _ in range(n_lines):
                cat = rng.choices(cats, weights=weights)[0]
                ps = by_cat[cat]
                p = rng.choices(ps, weights=[x["pop"] for x in ps])[0]
                qty = rng.randint(2, 6) if c["segment"] == "empresa" else (1 if rng.random() < 0.85 else 2)
                price = round(p["price"] * CHANNEL_PRICE[channel] * rng.uniform(0.98, 1.02), 2)
                discount = rng.choice([0, 0, 0, 0.05, 0.10]) + CHANNEL_DISCOUNT[channel]
                if c["segment"] == "clube":
                    discount += 0.05
                if cat == t["promo"] and d in PROMO_DAYS:
                    discount = 0.25
                if canceled:
                    status = "canceled"
                else:
                    status = "returned" if rng.random() < (0.12 if cat == t["returns"] else 0.03) else "delivered"
                yield (t["id"], day, order_id, c["id"], p["id"], channel, c["state"], c["segment"],
                       qty, price, round(min(discount, 0.4), 3), status, late, first)


def migrate(conn):
    """Aplica db/migrations/*.sql (idempotentes). O init.sql só roda com o volume vazio."""
    folder = os.path.join(os.path.dirname(os.path.abspath(__file__)), "migrations")
    for name in sorted(os.listdir(folder)) if os.path.isdir(folder) else []:
        if name.endswith(".sql"):
            with open(os.path.join(folder, name), encoding="utf-8") as f:
                conn.execute(f.read())
            print(f"seed: migração {name} aplicada")
    conn.commit()


def main():
    reset = "--reset" in sys.argv
    url = os.environ["DATABASE_URL"]
    with psycopg.connect(url) as conn:
        migrate(conn)
        with conn.cursor() as cur:
            cur.execute("select count(*) from warehouse.tenant")
            if cur.fetchone()[0] > 0 and not reset:
                print("seed: banco já populado, nada a fazer (use --reset para gerar de novo)")
                return
            if reset:
                cur.execute("truncate dashboards.dashboard, warehouse.order_line, warehouse.daily_load, "
                            "warehouse.product, warehouse.tenant, warehouse.state, warehouse.channel, "
                            "warehouse.segment cascade")

            cur.executemany("insert into warehouse.state values (%s, %s)", [s[:2] for s in STATES])
            cur.executemany("insert into warehouse.channel values (%s, %s)", [c[:2] for c in CHANNELS])
            cur.executemany("insert into warehouse.segment values (%s, %s)", [s[:2] for s in SEGMENTS])

            for t in TENANTS:
                rng = random.Random(f"{SEED}-{t['id']}")
                cur.execute("insert into warehouse.tenant values (%s, %s, %s, %s)",
                            (t["id"], t["name"], t["segment"], t["modules"]))
                products = build_catalog(rng, t)
                cur.executemany("insert into warehouse.product values (%s,%s,%s,%s,%s,%s)",
                                [(t["id"], p["id"], p["name"], p["category"], p["category_name"], p["cost"])
                                 for p in products])
                customers = build_customers(rng, t)

                total = 0
                with cur.copy(f"copy warehouse.order_line ({', '.join(COLS)}) from stdin") as cp:
                    for row in generate(rng, t, products, customers):
                        cp.write_row(row)
                        total += 1

                loads = []
                for d in range(DAYS):
                    day = START + timedelta(days=d)
                    if d in GAP_DAYS:
                        loads.append((t["id"], day, "failed", None))
                    else:
                        at = datetime.combine(day + timedelta(days=1), time(6, rng.randrange(0, 50)), tzinfo=timezone.utc)
                        loads.append((t["id"], day, "ok", at))
                cur.executemany("insert into warehouse.daily_load values (%s,%s,%s,%s)", loads)
                print(f"seed: {t['id']}: {len(products)} produtos, {len(customers)} clientes, {total} itens de pedido")
        conn.commit()
        # Sem estatísticas, o planejador estima 1 linha e escolhe nested loop (consulta lenta).
        conn.autocommit = True
        conn.execute("analyze")
    print(f"seed: pronto ({START} a {END}, sem carga em "
          f"{', '.join(str(START + timedelta(days=d)) for d in sorted(GAP_DAYS))})")


if __name__ == "__main__":
    main()
