import pytest

from app import db


@pytest.fixture(scope="session", autouse=True)
def pool():
    # Um pool para a rodada inteira (um pool fechado não reabre).
    db.pool.open(wait=True)
    yield
    db.pool.close()
