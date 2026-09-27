"""One operation-owned Host handle. Normal SIGTERM only; no retry or escalation."""
import hashlib
import fcntl
import stat
import json
import os
import select
import signal
import sys


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def emit(event):
    try:
        print(json.dumps(event, separators=(',', ':')), flush=True)
    except (BrokenPipeError, OSError):
        # The controller may have died after dispatch. Keep the gates through
        # the bounded signal/exit observation even when nobody can read output.
        pass


def observe(expected):
    root = '/proc/' + str(expected['pid'])
    with open(root + '/stat') as stream:
        fields = stream.read().rsplit(') ', 1)[1].split()
    with open(root + '/cmdline', 'rb') as stream:
        raw = stream.read(65537)
    if len(raw) > 65536:
        raise ValueError('cmdline')
    argv = raw.rstrip(b'\0').decode().split('\0')
    with open(root + '/environ', 'rb') as stream:
        raw = stream.read(2097153)
    if len(raw) > 2097152:
        raise ValueError('environ')
    env = dict(part.split(b'=', 1) for part in raw.split(b'\0') if b'=' in part)
    uid = os.stat(root).st_uid
    actual = dict(pid=expected['pid'], start=int(fields[19]), uid=uid,
                  exeDigest=digest(os.readlink(root + '/exe')),
                  argvDigest=digest(json.dumps(argv, ensure_ascii=False, separators=(',', ':'))))
    for key in actual:
        if actual[key] != expected[key]:
            raise ValueError('identity')
    if uid != os.getuid() or env.get(b'GROKBOX_OPERATION_ID') != expected['operationId'].encode():
        raise ValueError('owner')
    if env.get(b'GROKBOX_PRELOAD_MODE') != expected['mode'].encode():
        raise ValueError('mode')
    for key, expected_key in [(b'GROKBOX_BOX_RUNTIME_ROOT', 'rootDigest'), (b'GROKBOX_HOST_BUNDLE', 'targetDigest')]:
        value = env.get(key)
        if not value or digest(os.path.abspath(value.decode())) != expected[expected_key]:
            raise ValueError('launch')


fd = None
gates = [3, 4, 5]
try:
    identities = []
    for gate in gates:
        info = os.fstat(gate)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) & 0o077:
            raise ValueError('gate')
        identities.append((info.st_dev, info.st_ino))
        fcntl.flock(gate, fcntl.LOCK_EX | fcntl.LOCK_NB)
    if len(set(identities)) != 3:
        raise ValueError('gate')
    line = sys.stdin.buffer.readline(4097)
    if len(line) > 4096:
        raise ValueError('size')
    expected = json.loads(line)
    if set(expected) != {'pid', 'start', 'uid', 'exeDigest', 'argvDigest', 'operationId', 'mode', 'rootDigest', 'targetDigest'}:
        raise ValueError('shape')
    if type(expected['pid']) is not int or expected['pid'] <= 1 or type(expected['start']) is not int or expected['start'] < 1:
        raise ValueError('identity')
    fd = os.pidfd_open(expected['pid'])
    observe(expected)
    if select.select([fd], [], [], 0)[0]:
        raise ValueError('exited')
    emit({'event': 'pinned', 'pid': expected['pid'], 'start': expected['start']})
    command = sys.stdin.buffer.readline(64)
    if command != b'terminate\n':
        raise ValueError('command')
    observe(expected)
    if select.select([fd], [], [], 0)[0]:
        raise ValueError('exited')
    signal.pidfd_send_signal(fd, signal.SIGTERM)
    emit({'event': 'signaled', 'pid': expected['pid'], 'start': expected['start']})
    if select.select([fd], [], [], 15)[0]:
        emit({'event': 'exit-observed', 'pid': expected['pid'], 'start': expected['start']})
    else:
        emit({'event': 'exit-unproven', 'pid': expected['pid'], 'start': expected['start']})
except Exception:
    emit({'event': 'unproven'})
    sys.exit(1)
finally:
    if fd is not None:
        os.close(fd)
    for gate in gates:
        try:
            os.close(gate)
        except OSError:
            pass
