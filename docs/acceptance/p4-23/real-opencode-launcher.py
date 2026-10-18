#!/usr/bin/env python3
"""Acceptance-only real OpenCode launcher. No fixture responses or credential files.

The user-authorized planner credential configures the same MiMo service for this
OpenCode process only. Global OpenCode configuration and other agents stay intact.
"""
import json
import os
from pathlib import Path
import sqlite3
import sys
from urllib.parse import urlsplit

BINARY = '/opt/homebrew/bin/opencode'
if '--version' in sys.argv:
    os.execv(BINARY, [BINARY, *sys.argv[1:]])

path = Path(os.environ['SUPERCODE_DB'])
connection = sqlite3.connect('file:' + str(path) + '?mode=ro', uri=True)
config = json.loads(connection.execute('SELECT config_json FROM commander_config WHERE id=1').fetchone()[0])
url = urlsplit(config['endpoint'])
base_path = url.path.rstrip('/').removesuffix('/chat/completions')
scope = url.scheme + '://' + url.netloc + base_path + '|' + config['api_key_env']
row = connection.execute('SELECT key_value FROM commander_credentials WHERE scope=?', (scope,)).fetchone()
connection.close()
if row is None:
    raise SystemExit('Acceptance credential missing')

root = path.parent / 'real-opencode'
root.mkdir(mode=0o700, exist_ok=True)
config_home = root / 'config'
data_home = root / 'data'
config_home.mkdir(mode=0o700, exist_ok=True)
data_home.mkdir(mode=0o700, exist_ok=True)
environment = os.environ.copy()
environment['XDG_CONFIG_HOME'] = str(config_home)
environment['XDG_DATA_HOME'] = str(data_home)
environment.pop('OPENCODE_CONFIG', None)
environment['OPENCODE_CONFIG_CONTENT'] = json.dumps({
    'model': 'p423-mimo/' + config['model'],
    'provider': {'p423-mimo': {
        'npm': '@ai-sdk/openai-compatible',
        'name': 'Acceptance MiMo',
        'options': {'baseURL': url.scheme + '://' + url.netloc + base_path, 'apiKey': row[0].strip()},
        'models': {config['model']: {'name': 'Acceptance model'}},
    }},
    'permission': 'ask',
})
os.execve(BINARY, [BINARY, *sys.argv[1:]], environment)
