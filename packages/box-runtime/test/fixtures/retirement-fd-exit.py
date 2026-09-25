"""A single-thread zombie has released its fd table before waitpid reaps it."""
import fcntl
import json
import os
from pathlib import Path
import select
import sys
import tempfile
import time

path = Path(sys.argv[1])
observer = {'__name__': 'retirement_fd_exit', '__file__': str(path)}
exec(compile(path.read_bytes(), str(path), 'exec'), observer)
root = Path(tempfile.mkdtemp(prefix='retirement-fd-exit-'))
lock_path = root / 'lock'
lock_path.write_text('owned\n')
ready_read, ready_write = os.pipe()
release_read, release_write = os.pipe()
pid = os.fork()
if pid == 0:
    os.close(ready_read)
    os.close(release_write)
    held = os.open(lock_path, os.O_RDWR)
    fcntl.flock(held, fcntl.LOCK_EX)
    os.write(ready_write, b'r')
    os.close(ready_write)
    os.read(release_read, 1)
    # Leave held open: process exit, not an explicit unlock, releases it.
    os._exit(0)
os.close(ready_write)
os.close(release_read)
probe = None
try:
    assert select.select([ready_read], [], [], 5)[0]
    assert os.read(ready_read, 1) == b'r'
    row = observer['lifetime'](pid)
    assert not observer['exited_fd_table'](row)
    probe = os.open(lock_path, os.O_RDWR)
    try:
        fcntl.flock(probe, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        pass
    else:
        raise AssertionError('live child did not hold its lock')
    os.write(release_write, b'x')
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        result = os.waitid(os.P_PID, pid, os.WEXITED | os.WNOWAIT | os.WNOHANG)
        if result is not None:
            assert result.si_status == 0
            break
        time.sleep(.01)
    else:
        raise AssertionError('owned child did not exit')
    assert Path(f'/proc/{pid}/stat').exists()
    assert observer['exited_fd_table'](row)
    fcntl.flock(probe, fcntl.LOCK_EX | fcntl.LOCK_NB)
finally:
    os.close(ready_read)
    os.close(release_write)
    if probe is not None:
        os.close(probe)
    waited, status = os.waitpid(pid, 0)
    assert waited == pid and os.waitstatus_to_exitcode(status) == 0
print(json.dumps({'liveOwnerChecked': True, 'zombieStillInCensus': True, 'lockReleasedBeforeReap': True, 'ownedJoined': True, 'signals': 0}))
