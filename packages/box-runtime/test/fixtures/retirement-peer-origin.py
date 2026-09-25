"""Owned regression: a live socket can outlive its SO_PEERCRED creator."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time

observer_path = Path(sys.argv[1])
observer = {'__name__': 'retirement_peer_origin', '__file__': str(observer_path)}
exec(compile(observer_path.read_bytes(), str(observer_path), 'exec'), observer)
assert observer['libc'].prctl(36, 1, 0, 0, 0) == 0  # Adopt and join our orphan.
root = Path(tempfile.mkdtemp(prefix='retirement-peer-origin-'))
ready, release = root / 'ready.json', root / 'release'
program = '''
import json, os, socket, sys, time
from pathlib import Path
left, right = socket.socketpair()
if os.fork():
    os._exit(0)
ready = Path(sys.argv[1])
pending = ready.with_suffix('.pending')
pending.write_text(json.dumps({'pid': os.getpid(), 'fds': [left.fileno(), right.fileno()]}))
pending.replace(ready)
while not Path(sys.argv[2]).exists():
    time.sleep(.01)
left.close()
right.close()
os._exit(0)
'''
creator = subprocess.Popen([sys.executable, '-I', '-S', '-c', program, str(ready), str(release)],
                           stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
keeper = None
try:
    assert creator.wait(timeout=5) == 0
    deadline = time.monotonic() + 5
    while not ready.exists() and time.monotonic() < deadline:
        time.sleep(.01)
    keeper = json.loads(ready.read_text())
    assert not Path(f'/proc/{creator.pid}').exists()
    pfd = os.pidfd_open(keeper['pid'])
    try:
        duplicate = observer['libc'].syscall(438, pfd, keeper['fds'][0], 0)
        assert duplicate >= 0
        with observer['socket'].socket(fileno=duplicate) as channel:
            credential = observer['struct'].unpack('iII', channel.getsockopt(observer['socket'].SOL_SOCKET, observer['socket'].SO_PEERCRED, 12))
            assert credential[0] == creator.pid
        rows = observer['descriptors'](keeper['pid'], pfd, {'roots': [str(root)], 'inodes': []})
        assert all(any(row['fd'] == fd for row in rows) for fd in keeper['fds'])
        assert all(not row['locked'] and not row['relevant'] for row in rows)
    finally:
        os.close(pfd)
finally:
    release.write_text('release\n')
    if creator.poll() is None:
        assert creator.wait(timeout=5) == 0
    if keeper is None and ready.exists():
        keeper = json.loads(ready.read_text())
    if keeper is not None:
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            waited, status = os.waitpid(keeper['pid'], os.WNOHANG)
            if waited:
                assert os.waitstatus_to_exitcode(status) == 0
                break
            time.sleep(.01)
        else:
            raise RuntimeError('owned keeper did not settle')
print(json.dumps({'creatorAbsent': True, 'liveSocketsObserved': True, 'ownedJoined': True, 'signals': 0}))
