"""Formato da spec (porta 1 da validação). `extra="forbid"` = chave desconhecida é recusada.

Equivale a um Zod `.strict()`. O que não está aqui não existe: não há campo de cor, imagem,
URL, HTML ou SQL.
"""
from typing import Literal, Union

from pydantic import BaseModel, ConfigDict, Field

KIT_VERSION = "mvp-1"

Kind = Literal["kpi", "kpi_progress", "ranking_bar", "bar", "line", "table", "heatmap"]
Tone = Literal["positive", "negative", "neutral", "diverging", "accent"]
ParamType = Literal["product", "category", "channel", "state", "segment", "period"]


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ValueFilter(Strict):
    gt: float | None = None
    gte: float | None = None
    lt: float | None = None
    lte: float | None = None


class Query(Strict):
    metric: str = Field(min_length=1, max_length=60)
    dimensions: list[str] = Field(default_factory=list, max_length=3)
    filters: dict[str, Union[ValueFilter, list[str], str]] = Field(default_factory=dict)
    period: str | None = None
    sort: Literal["desc", "asc"] | None = None
    limit: int | None = Field(default=None, ge=1, le=500)
    of: str | None = None
    columns: list[str] | None = Field(default=None, max_length=3)


class Block(Strict):
    id: str = Field(pattern=r"^[a-z0-9][a-z0-9-]{0,39}$")
    kind: Kind
    span: int = Field(ge=1, le=12)
    title: str = Field(min_length=1, max_length=60)
    subtitle: str | None = Field(default=None, max_length=100)
    query: Query
    tone: Tone | None = None


class Row(Strict):
    blocks: list[Block] = Field(min_length=1, max_length=4)


class Param(Strict):
    type: ParamType
    default: Union[list[str], str]
    label: str | None = Field(default=None, max_length=40)


class Spec(Strict):
    schemaVersion: Literal[1]
    kitVersion: Literal["mvp-1"]
    title: str = Field(min_length=1, max_length=80)
    subtitle: str | None = Field(default=None, max_length=120)
    params: dict[str, Param] = Field(default_factory=dict)
    rows: list[Row] = Field(min_length=1, max_length=10)

    def blocks(self):
        for row in self.rows:
            yield from row.blocks

    def block(self, block_id: str) -> Block | None:
        return next((b for b in self.blocks() if b.id == block_id), None)
