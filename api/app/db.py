import os
from contextlib import contextmanager

from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

# statement_timeout de 5 s em toda conexão, para nenhuma consulta de dashboard segurar o banco.
pool = ConnectionPool(
    os.environ["DATABASE_URL"],
    min_size=1,
    max_size=10,
    kwargs={"autocommit": True, "row_factory": dict_row, "options": "-c statement_timeout=5000"},
    open=False,
)


@contextmanager
def conn():
    with pool.connection() as c:
        yield c
