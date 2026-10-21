"""Reset the explicitly approved 2026-10-06 development targets only.

Dry-run by default. Uses sibling AI service dependencies/credentials.
Preserves users, roles and permissions byte-for-byte, collections and indexes.
Never creates/deletes buckets or falls back to another environment.
Stop writers before --execute. Does not reset external video providers/local disk.
"""
import argparse
import hashlib
import json
import sys
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT.parents[1] / 'agents' / 'soulmed-agents'))

import boto3
from botocore.exceptions import ClientError
from bson import json_util
from pymongo import MongoClient
from app.config import get_settings

HOST = 'soulmedapp.ew7bkns.mongodb.net'
DATABASES = ('dkrTest', 'soulmed_ai_local')
BUCKETS = ('soulmed-dev-ai-ingest', 'soulmed-uploads-thumbnails')
PRESERVE = frozenset(('users', 'roles', 'permissions'))


def fingerprint(collection):
    rows = list(collection.find().sort('_id', 1))
    return len(rows), hashlib.sha256(json_util.dumps(rows, sort_keys=True).encode()).hexdigest()


def clear_bucket(s3, bucket, execute):
    result = {'bucket': bucket}
    # Version enumeration is separate from GetBucketVersioning: permissions differ.
    versioned = True
    try:
        entries = []
        for page in s3.get_paginator('list_object_versions').paginate(Bucket=bucket):
            entries.extend({'Key': obj['Key'], 'VersionId': obj['VersionId']}
                           for field in ('Versions', 'DeleteMarkers') for obj in page.get(field, []))
    except ClientError as exc:
        if exc.response['Error']['Code'] not in ('AccessDenied', 'AllAccessDisabled'):
            raise
        versioned = False
        entries = [{'Key': obj['Key']} for page in s3.get_paginator('list_objects_v2').paginate(Bucket=bucket)
                   for obj in page.get('Contents', [])]
    result.update(listed=len(entries), historical_versions_verified=versioned)
    if execute:
        deleted, errors = 0, []
        for start in range(0, len(entries), 1000):
            response = s3.delete_objects(Bucket=bucket, Delete={'Objects': entries[start:start + 1000], 'Quiet': False})
            deleted += len(response.get('Deleted', []))
            errors.extend(e.get('Code', 'Unknown') for e in response.get('Errors', []))
        result.update(deleted=deleted, deletion_errors=sorted(set(errors)), failed_objects=len(errors))
        result['remaining_current_objects'] = sum(len(page.get('Contents', [])) for page in
            s3.get_paginator('list_objects_v2').paginate(Bucket=bucket))
        if versioned:
            result['remaining_versions_and_markers'] = sum(len(page.get('Versions', [])) + len(page.get('DeleteMarkers', []))
                for page in s3.get_paginator('list_object_versions').paginate(Bucket=bucket))
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--execute', action='store_true')
    args = parser.parse_args()
    settings = get_settings()
    if (urlsplit(settings.mongodb_uri).hostname != HOST or settings.mongo_db_name != DATABASES[1]
            or settings.app_mongo_db_name != DATABASES[0]
            or urlsplit(settings.app_mongodb_uri or settings.mongodb_uri).hostname != HOST
            or settings.ai_ingest_s3_bucket != BUCKETS[0] or settings.vector_backend != 'atlas'):
        raise SystemExit('Configuration differs from the approved reset scope; refusing.')
    client = MongoClient(settings.mongodb_uri, serverSelectionTimeoutMS=10000)
    app_client = MongoClient(settings.app_mongodb_uri or settings.mongodb_uri, serverSelectionTimeoutMS=10000)
    s3 = boto3.Session(profile_name=settings.aws_profile or None, region_name=settings.aws_region).client('s3')
    report = {'execute': args.execute, 'preserved_collections': sorted(PRESERVE), 's3': [], 'mongo': []}
    # Clear storage before metadata, retaining known failures in the report.
    for bucket in BUCKETS:
        try:
            report['s3'].append(clear_bucket(s3, bucket, args.execute))
        except ClientError as exc:
            report['s3'].append({'bucket': bucket, 'error': exc.response['Error']['Code']})
    for name, connection in ((DATABASES[0], app_client), (DATABASES[1], client)):
        database = connection[name]
        collections = [c for c in database.list_collection_names() if not c.startswith('system.')]
        before = {c: fingerprint(database[c]) for c in collections if c in PRESERVE}
        result = {'database': name, 'collections': []}
        for collection in collections:
            if collection in PRESERVE:
                continue
            count = database[collection].count_documents({})
            deleted = database[collection].delete_many({}).deleted_count if args.execute else 0
            result['collections'].append({'name': collection, 'before': count, 'deleted': deleted,
                                          'remaining': database[collection].count_documents({})})
        result['preserved'] = {c: {'count': prior[0], 'unchanged': fingerprint(database[c]) == prior}
                               for c, prior in before.items()}
        report['mongo'].append(result)
    client.close()
    app_client.close()
    print(json.dumps(report, indent=2), flush=True)
    if args.execute:
        target = ROOT / 'docs' / 'ops' / '2026-10-06-data-reset-result.json'
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    failed = any(r.get('error') or r.get('failed_objects') or r.get('remaining_current_objects') or
                 r.get('remaining_versions_and_markers') for r in report['s3'])
    failed |= any(not p['unchanged'] for r in report['mongo'] for p in r['preserved'].values())
    if args.execute:
        failed |= any(c['remaining'] for r in report['mongo'] for c in r['collections'])
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
