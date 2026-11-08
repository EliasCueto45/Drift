import pytest
from drift_tools.testing import test_database as disposable_database
from drift_api.database import transaction
from drift_api.fixtures import seed_fixtures


@pytest.fixture(scope="session")
def mongo():
    with disposable_database() as db:
        yield db


@pytest.fixture
def run(mongo):
    for name in mongo.list_collection_names():
        if name not in ("transaction_guards", "schema_migrations"):
            mongo[name].delete_many({})

    def execute(fn):
        return transaction(fn, mongo)

    seed_fixtures(execute)
    return execute
