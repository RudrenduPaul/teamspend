from teamspend.types import SessionUsage, UserUsage, sum_cost, top_sessions, top_spenders


def _user(cost_usd: float, user_id: str = "u1") -> UserUsage:
    return UserUsage(
        user_id=user_id,
        user_email=f"{user_id}@x.com",
        input_tokens=0,
        output_tokens=0,
        cache_read_tokens=0,
        cache_write_tokens=0,
        requests=0,
        cost_usd=cost_usd,
        is_estimated=False,
    )


def _session(cost_usd: float, session_id: str = "s1") -> SessionUsage:
    return SessionUsage(
        session_id=session_id,
        cost_usd=cost_usd,
        input_tokens=0,
        output_tokens=0,
        requests=0,
        is_estimated=False,
    )


def test_sum_cost_adds_every_user():
    users = [_user(10), _user(5), _user(2.5)]
    assert sum_cost(users) == 17.5


def test_sum_cost_of_empty_list_is_zero():
    assert sum_cost([]) == 0


def test_top_spenders_sorts_descending_and_limits():
    users = [_user(10, "a"), _user(50, "b"), _user(30, "c")]
    result = top_spenders(users, 2)
    assert [u.user_id for u in result] == ["b", "c"]


def test_top_spenders_returns_fewer_than_limit_when_not_enough_users():
    users = [_user(10, "a")]
    result = top_spenders(users, 5)
    assert len(result) == 1


def test_user_usage_sessions_defaults_to_none():
    assert _user(10).sessions is None


def test_top_sessions_sorts_descending_and_limits():
    sessions = [_session(10, "a"), _session(50, "b"), _session(30, "c")]
    result = top_sessions(sessions, 2)
    assert [s.session_id for s in result] == ["b", "c"]


def test_top_sessions_returns_fewer_than_limit_when_not_enough_sessions():
    sessions = [_session(10, "a")]
    result = top_sessions(sessions, 5)
    assert len(result) == 1
