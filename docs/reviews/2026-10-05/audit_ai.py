"""Isolated evidence probes for the 2026-10-05 review, NOT security guarantees.

Passing finding_* tests reproduce current gaps; change their assertions when
fixing those gaps. All records and model/storage responses are synthetic.
Run with the AI service virtualenv; see the companion review for the command.
"""
import sys
from pathlib import Path

AI_REPO = Path(__file__).resolve().parents[5] / 'agents' / 'soulmed-agents'
sys.path.insert(0, str(AI_REPO))

import tests.conftest  # noqa: E402 -- installs safe test environment
import pytest  # noqa: E402
import jwt  # noqa: E402
from bson import ObjectId  # noqa: E402
from datetime import datetime, timezone  # noqa: E402
from fastapi import HTTPException  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from app.main import create_app  # noqa: E402
from app import auth, db  # noqa: E402
from app.v2 import auth as v2auth, tutor, media, settings as v2settings, usage  # noqa: E402
from app.tutor import service  # noqa: E402
from tests.conftest import FakeColl  # noqa: E402


@pytest.fixture
def student_client():
    app = create_app()
    user = auth.CurrentUser(id=str(ObjectId()), role='student', permissions=[])
    app.dependency_overrides[v2auth.get_current_user_v2] = lambda: user
    return TestClient(app), user


@pytest.mark.asyncio
async def test_finding_legacy_accepts_revoked_token_v2_refuses(monkeypatch):
    user_id = ObjectId()
    monkeypatch.setattr(db, 'users', lambda: FakeColl([{
        '_id': user_id, 'role': 'student', 'permissions': ['CanUseAiTutor'], 'token_version': 2,
    }]))
    token = jwt.encode({'sub': str(user_id), 'scope': 'ai', 'tv': 1}, auth.get_settings().jwt_secret, algorithm='HS256')
    assert (await auth.get_current_user('Bearer ' + token)).id == str(user_id)
    with pytest.raises(HTTPException) as caught:
        await v2auth.get_current_user_v2('Bearer ' + token)
    assert caught.value.status_code == 401


def test_finding_cached_followup_crosses_users_and_no_tutor_permission(student_client, monkeypatch):
    client, student_b = student_client
    subject = ObjectId()
    # This represents an answer generated using student A's conversation.
    cache = FakeColl([{'_id': ObjectId(), 'subject_id': subject,
        'question': 'explain it further', 'answer': 'SYNTHETIC_PRIVATE_CONTEXT_FROM_STUDENT_A',
        'citations': [], 'created_at': datetime.now(timezone.utc), 'hits': 0}])
    monkeypatch.setattr(tutor, 'answer_cache', lambda: cache)
    monkeypatch.setattr(db, 'subjects', lambda: FakeColl([{'_id': subject, 'name': 'Fixture subject'}]))
    conf = {'tutor.enabled': True, 'tutor.model_id': 'fixture', 'tutor.chunks': 4,
        'tutor.max_output_tokens': 400, 'tutor.prompt_caching': False, 'tutor.answer_cache_days': 7}
    async def get_many(*keys): return {key: conf[key] for key in keys}
    async def daily_cap(_): return 50
    async def count(_): return 0
    async def load_session(*args, **kwargs): return {'_id': ObjectId()}
    async def append(*args, **kwargs): pass
    monkeypatch.setattr(v2settings, 'get_many', get_many)
    monkeypatch.setattr(v2settings, 'daily_cap_for', daily_cap)
    monkeypatch.setattr(usage, 'questions_today', count)
    monkeypatch.setattr(usage, 'count_question', count)
    monkeypatch.setattr(tutor, '_load_session', load_session)
    monkeypatch.setattr(tutor, '_append_turns', append)
    response = client.post('/ai/v2/tutor/ask', json={'subject_id': str(subject), 'question': 'Explain it further'})
    assert response.status_code == 200
    assert 'SYNTHETIC_PRIVATE_CONTEXT_FROM_STUDENT_A' in response.text
    assert student_b.permissions == []


def test_finding_media_is_readable_without_authentication(monkeypatch):
    monkeypatch.setattr(media, 'load', lambda key: b'fixture-image-bytes')
    response = TestClient(create_app()).get('/ai/v2/media/' + 'a' * 32 + '.png')
    assert response.status_code == 200
    assert response.content == b'fixture-image-bytes'
    assert response.headers['cache-control'].startswith('public')


def test_finding_teacher_lists_jobs_without_subject_or_feature_permission(monkeypatch):
    teacher = auth.CurrentUser(id=str(ObjectId()), role='teacher', permissions=[])
    foreign_job = {'_id': ObjectId(), 'subject_id': ObjectId(), 'type': 'generate',
        'title': 'SYNTHETIC_OTHER_SUBJECT_JOB', 'status': 'queued', 'requested_by': ObjectId()}
    monkeypatch.setattr(db, 'jobs', lambda: FakeColl([foreign_job]))
    app = create_app()
    app.dependency_overrides[v2auth.get_current_user_v2] = lambda: teacher
    response = TestClient(app).get('/ai/v2/jobs')
    assert response.status_code == 200
    assert response.json()['jobs'][0]['id'] == str(foreign_job['_id'])


def test_finding_media_index_has_no_subject_or_feature_gate(monkeypatch):
    teacher = auth.CurrentUser(id=str(ObjectId()), role='teacher', permissions=[])
    foreign_subject = ObjectId()
    asset = {'_id': ObjectId(), 'subject_id': foreign_subject, 'key': 'fixture-key', 'url': 'fixture-url',
        'source': 'generated', 'parent_id': ObjectId(), 'draft_id': str(ObjectId()), 'role': 'question',
        'created_at': datetime.now(timezone.utc), 'uploaded_by_name': 'Fixture admin'}
    monkeypatch.setattr(media, 'assets', lambda: FakeColl([asset]))
    monkeypatch.setattr(db, 'draft_questions', lambda: FakeColl([]))
    app = create_app()
    app.dependency_overrides[v2auth.get_current_user_v2] = lambda: teacher
    response = TestClient(app).get('/ai/v2/media/index', params={'subject_id': str(foreign_subject)})
    assert response.status_code == 200
    assert response.json()['images'][0]['key'] == 'fixture-key'


def test_control_student_cannot_read_other_session(student_client, monkeypatch):
    client, student_b = student_client
    session_id = ObjectId()
    monkeypatch.setattr(db, 'qa_sessions', lambda: FakeColl([{
        '_id': session_id, 'user_id': ObjectId(), 'messages': [{'content': 'SYNTHETIC_OTHER_HISTORY'}],
    }]))
    response = client.get('/ai/v2/tutor/sessions/' + str(session_id))
    assert response.status_code == 404
    assert 'SYNTHETIC_OTHER_HISTORY' not in response.text


@pytest.mark.parametrize('path', ['/ai/v2/settings', '/ai/v2/status', '/ai/v2/jobs',
    '/ai/v2/media/index?subject_id=000000000000000000000001'])
def test_control_student_denied_staff_screens(student_client, path):
    client, _ = student_client
    assert client.get(path).status_code == 403


def test_control_anonymous_denied_all_declared_authenticated_routes():
    from fastapi.routing import APIRoute
    app = create_app()
    client = TestClient(app)
    def names(dep):
        return {getattr(dep.call, '__name__', '')} | set().union(*(names(d) for d in dep.dependencies))
    checked = 0
    for route in app.routes:
        if not isinstance(route, APIRoute): continue
        if not names(route.dependant) & {'get_current_user', 'get_current_user_v2'}: continue
        import re
        path = re.sub(r'\{[^}]+\}', '000000000000000000000001', route.path)
        for method in route.methods:
            response = client.request(method, path)
            assert response.status_code == 401, (method, route.path, response.status_code)
            checked += 1
    assert checked == 80
