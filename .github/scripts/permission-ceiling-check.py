#!/usr/bin/env python3
"""Callers must grant every permission the callables' jobs request.

A reusable workflow cannot get more GITHUB_TOKEN permission than the calling
job grants; if any job asks for more, GitHub rejects the whole run at startup
("workflow file issue"). Run: python3 .github/scripts/permission-ceiling-check.py
"""
import glob
import os
import re
import sys

import yaml

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
RANK = {'none': 0, 'read': 1, 'write': 2}


def perms(p):
    if p == 'write-all':
        return {'*': 'write'}
    if p == 'read-all':
        return {'*': 'read'}
    return p if isinstance(p, dict) else None


problems = 0
for caller in sorted(glob.glob(os.path.join(ROOT, 'stacks/claude/callers/*.yml.tmpl'))):
    doc = yaml.safe_load(re.sub(r'\{\{[A-Z_0-9]+\}\}', 'X', open(caller).read()))
    for job_name, job in (doc.get('jobs') or {}).items():
        m = re.match(r'MervinPraison/github-automation-template/(.+)@', job.get('uses', ''))
        if not m:
            continue
        granted = perms(job.get('permissions')) or perms(doc.get('permissions')) or {}
        callable_doc = yaml.safe_load(open(os.path.join(ROOT, m.group(1))))
        default = perms(callable_doc.get('permissions')) or {}
        for cjob, cj in callable_doc['jobs'].items():
            for scope, level in (perms(cj.get('permissions')) or default).items():
                have = granted.get(scope, granted.get('*', 'none'))
                if RANK.get(level, 0) > RANK.get(have, 0):
                    problems += 1
                    print(f'FAIL: {os.path.basename(caller)}:{job_name} -> {cjob} needs {scope}: {level}, caller grants {have}')
print('ok: callers grant every permission the callables request' if not problems else f'{problems} permission problem(s)')
sys.exit(1 if problems else 0)
