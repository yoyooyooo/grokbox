#!/usr/bin/env python3
"""Read-only Linux retirement observer. Python >=3.11, x86_64 ELF64.

stdin/stdout is a private, bounded JSON-lines protocol owned by the recovery
Effect scope. No environment, argv, paths, file contents or socket data appear
in observations. Descriptor duplicates are never read/written or reconfigured.
"""
import contextlib
import ctypes
import hashlib
import json
import os
import platform
import select
import socket
import stat
import struct
import sys
from pathlib import Path

LIMIT = 4 * 1024 * 1024
PAGE = os.sysconf('SC_PAGE_SIZE')
libc = ctypes.CDLL(None, use_errno=True)
libc.syscall.restype = ctypes.c_long


def require(ok):
    if not ok:
        raise ValueError('unproved')


def digest(data):
    return hashlib.sha256(data).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()


def read(path, limit=LIMIT):
    parts, size = [], 0
    with open(path, 'rb') as source:
        while size <= limit:
            chunk = source.read(min(65536, limit + 1 - size))
            if not chunk:
                break
            parts.append(chunk)
            size += len(chunk)
    require(size <= limit)
    return b''.join(parts)


def lifetime(pid):
    raw = read(f'/proc/{pid}/stat')
    require(raw.startswith(f'{pid} ('.encode()))
    fields = raw[raw.rfind(b') ') + 2:].split()
    require(len(fields) >= 50)
    return {'pid': pid, 'start': int(fields[19]), 'pgid': int(fields[2]), 'sid': int(fields[3])}


def same(a, b):
    return a['pid'] == b['pid'] and a['start'] == b['start']


def context(anchor, clock):
    status = dict(line.split(':', 1) for line in read('/proc/self/status').decode().splitlines() if ':' in line)
    require(all(list(map(int, status[key].split())) == [os.getpid()] for key in ('NSpid', 'NStgid')))
    mounts = read('/proc/self/mountinfo').decode().splitlines()
    found = []
    for line in mounts:
        left, right = line.split(' - ', 1)
        a, b = left.split(), right.split()
        if a[4] == '/proc':
            require(a[3] == '/' and b[0] == 'proc')
            require(not any(x.startswith(('hidepid=', 'subset=')) and x != 'hidepid=0'
                            for x in a[5].split(',') + b[2].split(',')))
            found.append(line)
        require(not a[4].startswith('/proc/') or not a[4].split('/')[2].isdigit())
    # Mount stacks can retain hidden procfs rows. Bind the actually opened
    # directory's mount ID instead of mistaking a hidden row for our view.
    with opened('/proc') as procfd:
        fdinfo = dict(line.split(':', 1) for line in read(f'/proc/self/fdinfo/{procfd}').decode().splitlines() if ':' in line)
        active_mount = int(fdinfo['mnt_id'])
        selected = [line for line in found if int(line.split()[0]) == active_mount]
        require(len(selected) == 1)
    require(same(lifetime(anchor['pid']), anchor))
    ns = {key: os.readlink('/proc/self/ns/' + key) for key in ('pid', 'time', 'mnt')}
    require(all(os.readlink(f'/proc/{anchor["pid"]}/ns/{key}') == value for key, value in ns.items() if key != "mnt"))
    require(same(lifetime(clock['anchor']['pid']), clock['anchor']) and abs(clock['anchor']['start'] - clock['originalStart']) <= 1)
    require(all(os.readlink(f'/proc/{clock["anchor"]["pid"]}/ns/{key}') == value for key, value in ns.items() if key != "mnt"))
    # procfs magic, not a pathname assumption.
    buf = ctypes.create_string_buffer(256)
    require(libc.statfs(b'/proc', buf) == 0 and struct.unpack_from('l', buf)[0] == 0x9fa0)
    return {'bootId': read('/proc/sys/kernel/random/boot_id').decode().strip(), **ns, 'anchor': anchor, 'clock': clock}, digest(canonical(found))


def census():
    names = sorted(int(p) for p in os.listdir('/proc') if p.isdigit())
    rows = []
    for pid in names:
        before = lifetime(pid)
        fields = dict(line.split(':', 1) for line in read(f'/proc/{pid}/status').decode().splitlines() if ':' in line)
        nspid, nstgid = [list(map(int, fields[key].split())) for key in ('NSpid', 'NStgid')]
        require(nspid and nstgid and nspid[0] == pid and nstgid[0] == pid and lifetime(pid) == before)
        rows.append({**before, 'nspid': nspid, 'nstgid': nstgid})
    require(names == sorted(int(p) for p in os.listdir('/proc') if p.isdigit()))
    return rows


def regions(raw):
    result = []
    for line in raw.decode().splitlines():
        a = line.split(None, 5)
        lo, hi = [int(x, 16) for x in a[0].split('-')]
        major, minor = [int(x, 16) for x in a[3].split(':')]
        result.append({'lo': lo, 'hi': hi, 'perm': a[1], 'offset': int(a[2], 16),
                       'dev': [major, minor], 'ino': int(a[4]), 'path': a[5] if len(a) == 6 else ''})
    return result


def file_stamp(fd):
    s = os.fstat(fd)
    return [s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns, s.st_mode]


@contextlib.contextmanager
def opened(path):
    fd = os.open(path, os.O_RDONLY | os.O_CLOEXEC | os.O_NONBLOCK)
    try:
        yield fd
    finally:
        os.close(fd)


def image(pid):
    with opened(f'/proc/{pid}/exe') as exe, opened(f'/proc/{pid}/mem') as memory:
        stamp = file_stamp(exe)
        require(64 <= stamp[2] <= 256 * 1024 * 1024)
        data = os.pread(exe, stamp[2], 0)
        require(len(data) == stamp[2])
        header = struct.unpack_from('<16sHHIQQQIHHHHHH', data)
        require(header[0][:6] == b'\x7fELF\x02\x01' and header[1] in (2, 3) and header[2] == 62 and header[9] == 56)
        entry, phoff, phnum = header[4], header[5], header[10]
        require(0 < phnum < 256 and phoff + phnum * 56 <= len(data))
        phdrs = [struct.unpack_from('<IIQQQQQQ', data, phoff + i * 56) for i in range(phnum)]
        auxraw, mapsraw = read(f'/proc/{pid}/auxv'), read(f'/proc/{pid}/maps')
        require(len(auxraw) % 16 == 0)
        aux = {key: value for key, value in struct.iter_unpack('<QQ', auxraw) if key}
        require(aux[4] == 56 and aux[5] == phnum)
        bias = aux[9] - entry
        require(bias >= 0 and bias % PAGE == 0 and (header[1] != 2 or bias == 0))
        location = next((p[3] for p in phdrs if p[0] == 6), None)
        if location is None:
            p = next(p for p in phdrs if p[0] == 1 and p[2] <= phoff and phoff + phnum * 56 <= p[2] + p[5])
            location = p[3] + phoff - p[2]
        require(aux[3] == bias + location)
        require(os.pread(memory, phnum * 56, aux[3]) == data[phoff:phoff + phnum * 56])
        mappings = regions(mapsraw)
        dev = [os.major(stamp[0]), os.minor(stamp[0])]
        for p in phdrs:
            if p[0] != 1 or not p[1] & 1:
                continue
            require(0 < p[5] <= p[6] and p[2] + p[5] <= len(data))
            start, end = bias + p[3], bias + p[3] + p[5]
            pos = start
            while pos < end:
                region = next(r for r in mappings if r['lo'] <= pos < r['hi'])
                require('x' in region['perm'] and 'w' not in region['perm'] and region['ino'] == stamp[1] and region['dev'] == dev)
                require(region['offset'] + pos - region['lo'] == p[2] + pos - start)
                pos = min(end, region['hi'])
        require(any(p[0] == 1 and p[1] & 1 and bias + p[3] <= aux[9] < bias + p[3] + p[5] for p in phdrs))
        loaded, libraries = [], []
        for region in mappings:
            if 'x' not in region['perm']:
                continue
            require('w' not in region['perm'])
            if region['path'] in ('[vdso]', '[vsyscall]'):
                require(region['ino'] == 0)
                continue
            require(region['ino'] > 0 and region['path'].startswith('/') and not region['path'].endswith(' (deleted)'))
            main = region['ino'] == stamp[1] and region['dev'] == dev
            with opened(f'/proc/{pid}/root' + region['path']) as mapped:
                initial = file_stamp(mapped)
                require(initial[1] == region['ino'] and [os.major(initial[0]), os.minor(initial[0])] == region['dev'])
                require(0 < initial[2] <= 256 * 1024 * 1024)
                content = os.pread(mapped, initial[2], 0)
                require(len(content) == initial[2] and content[:6] == b'\x7fELF\x02\x01')
                length = region['hi'] - region['lo']
                require(0 < length <= 64 * 1024 * 1024 and region['offset'] < len(content))
                expected = content[region['offset']:region['offset'] + length]
                # Include executable page padding: unexplained bytes are never ignored.
                expected += b'\0' * (length - len(expected))
                actual = os.pread(memory, length, region['lo'])
                require(actual == expected and file_stamp(mapped) == initial)
                loaded.append(digest(actual))
                if not main:
                    libraries.append(digest(content))
        require(file_stamp(exe) == stamp and read(f'/proc/{pid}/auxv') == auxraw and read(f'/proc/{pid}/maps') == mapsraw)
        with opened(f'/proc/{pid}/exe') as current:
            require(file_stamp(current) == stamp)
        return {'sha256': digest(data), 'libraries': sorted(set(libraries)),
                'anchorSha256': digest(canonical([stamp, digest(auxraw), digest(mapsraw), loaded]))}


def relevant(target, s, resources):
    return any(target == root or target.startswith(root + '/') or target.startswith(root + ' (deleted)') for root in resources['roots']) or any(
        s.st_dev == row['dev'] and s.st_ino == row['ino'] for row in resources['inodes'])


def address(fd, peer=False):
    buf, length = ctypes.create_string_buffer(256), ctypes.c_uint(256)
    rc = (libc.getpeername if peer else libc.getsockname)(fd, buf, ctypes.byref(length))
    if rc:
        require(peer and ctypes.get_errno() == 107)  # ENOTCONN, not arbitrary unreadability.
        return None
    return bytes(buf.raw[:length.value]).hex()


def descriptors(pid, pfd, resources):
    names = sorted(map(int, os.listdir(f'/proc/{pid}/fd')))
    rows = []
    for number in names:
        path = f'/proc/{pid}/fd/{number}'
        target, before = os.readlink(path), read(f'/proc/{pid}/fdinfo/{number}')
        duplicate = libc.syscall(438, pfd, number, 0)  # pidfd_getfd on supported x86_64.
        if duplicate < 0:
            raise OSError(ctypes.get_errno(), 'capability-unavailable')
        try:
            s = os.fstat(duplicate)
            named = os.stat(path)
            require((s.st_dev, s.st_ino, s.st_mode) == (named.st_dev, named.st_ino, named.st_mode))
            facts = {'dev': s.st_dev, 'ino': s.st_ino, 'mode': s.st_mode, 'targetSha256': digest(target.encode()), 'infoSha256': digest(before)}
            resource = relevant(target, s, resources)
            if stat.S_ISSOCK(s.st_mode):
                # socket.socket owns this one duplicate and closes it; never changes its flags.
                with socket.socket(fileno=duplicate) as sock:
                    duplicate = -1
                    local, peer = address(sock.fileno()), address(sock.fileno(), True)
                    facts['socket'] = {'domain': sock.getsockopt(socket.SOL_SOCKET, socket.SO_DOMAIN), 'type': sock.getsockopt(socket.SOL_SOCKET, socket.SO_TYPE),
                                       'listening': sock.getsockopt(socket.SOL_SOCKET, socket.SO_ACCEPTCONN), 'local': local, 'peer': peer}
                    if facts['socket']['domain'] == socket.AF_UNIX:
                        credential = struct.unpack('iII', sock.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
                        facts['socket']['credential'] = list(credential)
                        if credential[0] > 0:
                            facts['socket']['peerLifetime'] = lifetime(credential[0])
                    for encoded in (local, peer):
                        if encoded:
                            raw = bytes.fromhex(encoded)
                            resource |= any(root.encode() in raw for root in resources['roots'])
            require(os.readlink(path) == target and read(f'/proc/{pid}/fdinfo/{number}') == before)
            rows.append({'fd': number, 'digest': digest(canonical(facts)), 'relevant': resource, 'locked': b'lock:' in before})
        finally:
            if duplicate >= 0:
                os.close(duplicate)
    require(names == sorted(map(int, os.listdir(f'/proc/{pid}/fd'))))
    return rows


def modeld_peer(modeld):
    if modeld['kind'] == 'absent':
        require(not os.path.lexists(modeld['socketPath']))
        return None
    before = os.stat(modeld['socketPath'], follow_symlinks=False)
    require(stat.S_ISSOCK(before.st_mode))
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
        # Same timeout as the existing modeld observation port; this is our own
        # query connection, never a duplicated application descriptor.
        sock.settimeout(0.5)
        sock.connect(modeld['socketPath'])
        pid, uid, gid = struct.unpack('iII', sock.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
        owner = lifetime(pid)
        require(same(owner, modeld['owner']) and uid == os.getuid())
        argv = read(f'/proc/{pid}/cmdline').split(b'\0')
        require(modeld['codePath'].encode() in argv)
        with opened(modeld['codePath']) as code:
            stamp = file_stamp(code)
            require(stat.S_ISREG(stamp[5]) and stamp[2] <= 64 * 1024 * 1024)
            code_digest = digest(os.pread(code, stamp[2], 0))
            require(file_stamp(code) == stamp and code_digest == modeld['codeSha256'])
        require(same(lifetime(pid), owner))
    after = os.stat(modeld['socketPath'], follow_symlinks=False)
    require((before.st_dev, before.st_ino) == (after.st_dev, after.st_ino))
    return {'owner': {'pid': pid, 'start': owner['start']}, 'codeSha256': code_digest,
            'socketSha256': digest(canonical([before.st_dev, before.st_ino, before.st_mode]))}


def relevant_preload(pid):
    # Presence-only, matching the existing official-chain guard. Never return
    # environment values or hashes of unrelated credentials.
    entries = read(f'/proc/{pid}/environ').split(b'\0')
    return any(key.startswith(b'GROKBOX_') or key == b'NODE_OPTIONS' and any(word in value for word in (b'grokbox', b'--require', b'--import'))
               for item in entries if b'=' in item for key, value in [item.split(b'=', 1)])


def observe(request):
    q = request['qualification']
    before, mount = context(q['view']['anchor'], q['view']['clock'])
    require(before == q['view'])
    peer = modeld_peer(q['resources']['modeld'])
    first = census()
    scope = q['hostScope']
    targets = request['targets']
    selected = [row for row in first if any(s['retirement'] == 'node-image-or-absence' and s['lowerInclusive'] <= row['start'] <= s['upper']['start'] and row['pid'] != s['upper']['pid'] for s in q['resources']['scopes'])
                or any(same(row, host) for host in targets['hosts'])
                or targets['markerPid'] in row['nspid'] or targets['markerPid'] in row['nstgid']
                or (scope['lowerInclusive'] <= row['start'] <= scope['upper']['start']
                    and row['pid'] != scope['upper']['pid'] and row['pgid'] == row['sid'] == row['pid'])]
    candidates = []
    for row in selected:
        pfd = os.pidfd_open(row['pid'])
        try:
            poll = select.poll()
            poll.register(pfd, select.POLLIN)
            require(not poll.poll(0) and same(lifetime(row['pid']), row))
            preload = relevant_preload(row['pid'])
            current = image(row['pid'])
            fds = descriptors(row['pid'], pfd, q['resources'])
            require(relevant_preload(row['pid']) == preload and image(row['pid']) == current and not poll.poll(0) and same(lifetime(row['pid']), row))
            candidates.append({'lifetime': {'pid': row['pid'], 'start': row['start']}, 'image': current, 'descriptors': fds, 'relevantPreload': preload})
        finally:
            os.close(pfd)
    holders = []
    for row in first:
        # Observer-owned fds are closed before returning, never independent survivors.
        if row['pid'] == os.getpid():
            continue
        found = False
        for name in os.listdir(f'/proc/{row["pid"]}/fd'):
            path = f'/proc/{row["pid"]}/fd/{name}'
            target, s = os.readlink(path), os.stat(path)
            found |= relevant(target, s, q['resources'])
        if found:
            holders.append({'pid': row['pid'], 'start': row['start']})
    require(first == census() and (before, mount) == context(q['view']['anchor'], q['view']['clock']))
    require(modeld_peer(q['resources']['modeld']) == peer)
    return {'version': 1, 'view': before, 'procMountSha256': mount, 'census': first, 'candidates': candidates, 'resourceHolders': holders, 'modeld': peer}


def main():
    require(sys.version_info >= (3, 11) and sys.platform == 'linux' and platform.machine() == 'x86_64' and hasattr(os, 'pidfd_open'))
    print('{"version":1,"ready":true}', flush=True)
    for line in sys.stdin.buffer:
        require(len(line) <= LIMIT)
        try:
            request = json.loads(line)
            result = observe(request)
            encoded = json.dumps({'ok': True, 'observation': result}, separators=(',', ':'))
            require(len(encoded) <= LIMIT)
            print(encoded, flush=True)
        except Exception:
            # Errors never echo private paths, process data or exception bodies.
            print('{"ok":false,"code":"restoration-observation-unproved"}', flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        sys.exit(1)
