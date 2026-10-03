def pytest_configure(config):
    config.addinivalue_line("markers", "slow: runs the optimizer on the full demo fixture with the default budget")
