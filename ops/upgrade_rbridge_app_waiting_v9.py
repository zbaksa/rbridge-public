#!/usr/bin/python3
"""One-shot, fail-closed RBridge V9 live-base hotfix installer.

Use only after exact-source GitHub CI PASS. It builds under rbridge-ci,
copies the existing immutable release, overlays only two compiled JS files,
checks durable quiescence twice, then switches with automatic rollback.
No credentials are printed, and other COCWIN/Games2D services are untouched.
"""
import fcntl
import json
import os
import pathlib
import pwd
import re
import shutil
import socket
import stat
import subprocess
import sys
import tempfile

OLD = "008885e07394f20746f034cbd7fe52c6b520533d"
NEW = "dcf3cb9ad8b43532c19fff849eab086b280915d9"
REPO = "https://github.com/zbaksa/rbridge-public.git"
BASE = pathlib.Path("/usr/local/libexec/rbridge")
RELEASES = BASE / "releases"
CURRENT = BASE / "current"
STATE = pathlib.Path("/home/rbridge/.local/state/rbridge")
ENVFILE = pathlib.Path("/etc/rbridge/runtime.env")
FLOWPILOT_ENV = pathlib.Path("/etc/rbridge/flowpilot.env")
SERVICE = "rbridge.service"
PATH = "/opt/ai-tool-fabric/runtime:/usr/local/bin:/usr/bin:/bin"
OUTFILES = ("remoteBridgeStore.js", "remoteBridgeWorker.js")
DIST = pathlib.Path("dist/server/server")


def require(ok, code):
    if not ok:
        raise RuntimeError(code)


def exec_safe(argv, *, cwd=None, uid=None, timeout=180):
    args = list(argv)
    env = {"PATH": PATH, "LANG": "C.UTF-8", "GIT_TERMINAL_PROMPT": "0"}
    if uid is not None:
        user = pwd.getpwuid(uid)
        args = ["/usr/sbin/runuser", "-u", user.pw_name, "--"] + args
        env["HOME"] = user.pw_dir
    p = subprocess.run(args, cwd=cwd, env=env, text=True,
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                       timeout=timeout, check=False)
    if p.returncode:
        raise RuntimeError("COMMAND_FAILED:" + pathlib.Path(argv[0]).name
                           + ":" + str(p.returncode)
                           + ":" + p.stderr.strip()[-180:])
    return p.stdout.strip()


def active():
    p = subprocess.run(["/usr/bin/systemctl", "is-active", SERVICE],
                       env={"PATH": PATH, "LANG": "C.UTF-8"},
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                       text=True, timeout=12)
    state = p.stdout.strip()
    if p.returncode == 0 and state == "active":
        return True
    if p.returncode != 0 and state in ("inactive", "failed", "deactivating"):
        return False
    raise RuntimeError("SERVICE_STATE_UNKNOWN")




def symlink_target():
    s = CURRENT.lstat()
    require(stat.S_ISLNK(s.st_mode) and s.st_uid == 0, "CURRENT_NOT_ROOT_SYMLINK")
    return CURRENT.resolve(strict=True)


def checked_file(p, max_bytes=160000):
    s = p.lstat()
    require(stat.S_ISREG(s.st_mode) and s.st_nlink == 1 and s.st_size <= max_bytes,
            "FILE_METADATA_UNSAFE:" + p.name)
    fd = os.open(p, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        with os.fdopen(fd, "rb") as f:
            b = f.read(max_bytes + 1)
        require(len(b) == s.st_size, "FILE_CHANGED:" + p.name)
        return b
    except Exception:
        raise


def quiescence():
    require(STATE.is_dir() and not STATE.is_symlink(), "STATE_ROOT_UNKNOWN")
    pending = []
    for p in STATE.iterdir():
        if p.suffix != ".json":
            continue
        raw = checked_file(p, 2097152)
        row = json.loads(raw)
        require(row.get("schema") == "COCWIN_REMOTE_BRIDGE_STORE_V1"
                and row.get("requestId") + ".json" == p.name,
                "DURABLE_IDENTITY_UNKNOWN")
        phase = row.get("phase")
        require(phase in ("CLAIMED", "WAITING", "SUBMITTED", "TERMINAL", "PUBLISHED"),
                "DURABLE_PHASE_UNKNOWN")
        if phase != "PUBLISHED":
            pending.append((p.name, phase))
    sessions = STATE / "sessions"
    session_states = {}
    if sessions.exists():
        require(sessions.is_dir() and not sessions.is_symlink(), "SESSIONS_UNSAFE")
        for p in sessions.iterdir():
            if p.name == "start-claims" or not p.is_dir():
                continue
            require(not p.is_symlink(), "SESSION_SYMLINK")
            rec = p / "record.json"
            require(rec.exists(), "SESSION_RECORD_ABSENT")
            row = json.loads(checked_file(rec, 2097152))
            require(row.get("schema") == "COCWIN_REMOTE_BRIDGE_PROCESS_SESSION_V1"
                    and row.get("sessionId") == p.name, "SESSION_ID_MISMATCH")
            session_states[p.name] = row.get("state")
            if row.get("state") not in ("SUCCEEDED", "FAILED", "TERMINATED"):
                pending.append((p.name, "SESSION_" + str(row.get("state"))))
        claims = sessions / "start-claims"
        if claims.exists():
            require(claims.is_dir() and not claims.is_symlink(), "CLAIMS_UNSAFE")
            for p in claims.iterdir():
                if p.suffix != ".json":
                    continue
                row = json.loads(checked_file(p, 2097152))
                require(row.get("schema") == "COCWIN_REMOTE_BRIDGE_PROCESS_START_CLAIM_V1"
                        and row.get("sessionId") in session_states
                        and session_states[row["sessionId"]] in ("SUCCEEDED", "FAILED", "TERMINATED"),
                        "UNRESOLVED_START_CLAIM")
    require(not pending, "DURABLE_IN_FLIGHT:" + str(pending[:5]))
    return True


def write_atomic(p, raw, mode=0o600):
    tmp = p.with_name("." + p.name + ".v9-" + str(os.getpid()))
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(raw)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(tmp, mode)
        os.replace(tmp, p)
    finally:
        try:
            tmp.unlink()
        except FileNotFoundError:
            pass


def main():
    require(os.geteuid() == 0 and os.getegid() == 0, "ROOT_REQUIRED")
    require(socket.gethostname().split(".")[0] == "aether-engine", "WRONG_HOST")
    require(active(), "RBRIDGE_NOT_ACTIVE")
    old_dir = RELEASES / OLD
    new_dir = RELEASES / NEW
    require(symlink_target() == old_dir and old_dir.is_dir(), "LIVE_RELEASE_CHANGED")
    require(not new_dir.exists(), "TARGET_RELEASE_ALREADY_EXISTS")
    require(not STATE.is_symlink(), "STATE_SYMLINK")
    user = pwd.getpwnam("rbridge-ci")
    require(user.pw_uid != 0, "CI_ACCOUNT_INVALID")
    oldenv = checked_file(ENVFILE, 131072)
    envtext = oldenv.decode("utf8")
    old_setting = "RBRIDGE_RELEASE_SHA=" + OLD
    require(envtext.splitlines().count(old_setting) == 1, "RELEASE_ENV_NOT_EXACT")
    if FLOWPILOT_ENV.exists():
        flowtext = checked_file(FLOWPILOT_ENV, 131072).decode("utf8")
        require(not re.search(r"^RBRIDGE_RELEASE_SHA=", flowtext, re.M),
                "CONFLICTING_RELEASE_ENV")
    lockfd = os.open("/run/lock/rbridge-v9-waiting-upgrade.lock",
                     os.O_CREAT | os.O_RDWR | os.O_CLOEXEC, 0o600)
    fcntl.flock(lockfd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    quiescence()
    print("V9_PRECHECK_PASS", flush=True)

    tmp = pathlib.Path(tempfile.mkdtemp(prefix="rbridge-v9-", dir="/var/tmp"))
    os.chown(tmp, user.pw_uid, user.pw_gid)
    stopped = False
    switched = False
    envchanged = False
    try:
        checkout = tmp / "repo"
        exec_safe(["/usr/bin/git", "clone", "--quiet", "--no-checkout", REPO, str(checkout)],
                  uid=user.pw_uid, timeout=120)
        exec_safe(["/usr/bin/git", "-C", str(checkout), "checkout", "--quiet",
                   "--detach", NEW], uid=user.pw_uid, timeout=30)
        require(exec_safe(["/usr/bin/git", "-C", str(checkout), "rev-parse", "HEAD"],
                          uid=user.pw_uid, timeout=10) == NEW, "SOURCE_SHA_MISMATCH")
        exec_safe(["/usr/bin/env", "npm", "ci", "--ignore-scripts"],
                  cwd=checkout, uid=user.pw_uid, timeout=240)
        exec_safe(["/usr/bin/env", "npm", "run", "build:server"],
                  cwd=checkout, uid=user.pw_uid, timeout=120)

        staged = RELEASES / ("." + NEW + ".stage-" + str(os.getpid()))
        require(not staged.exists(), "STAGING_EXISTS")
        shutil.copytree(old_dir, staged, symlinks=True)
        for name in OUTFILES:
            compiled = checked_file(checkout / DIST / name)
            require(b"WAITING" in compiled, "COMPILED_WAITING_MISSING:" + name)
            installed = staged / DIST / name
            checked_file(installed)
            write_atomic(installed, compiled, 0o644)
            os.chown(installed, 0, 0)
        os.rename(staged, new_dir)
        print("V9_RELEASE_STAGED_EXACT=" + NEW, flush=True)

        require(symlink_target() == old_dir and active(), "LIVE_CHANGED_BEFORE_STOP")
        quiescence()
        exec_safe(["/usr/bin/systemctl", "stop", SERVICE], timeout=40)
        stopped = True
        require(not active(), "STOP_NOT_CONFIRMED")
        quiescence()
        print("V9_QUIESCENCE_PASS", flush=True)

        linktmp = BASE / (".current-v9-" + str(os.getpid()))
        os.symlink(str(new_dir), linktmp)
        os.replace(linktmp, CURRENT)
        switched = True
        newenv = envtext.replace(old_setting, "RBRIDGE_RELEASE_SHA=" + NEW, 1)
        write_atomic(ENVFILE, newenv.encode("utf8"))
        envchanged = True
        require(symlink_target() == new_dir, "NEW_SYMLINK_INVALID")
        exec_safe(["/usr/bin/systemctl", "start", SERVICE], timeout=50)
        require(active(), "RESTART_NOT_ACTIVE")
        print("V9_ACTIVATED_SERVICE_ACTIVE=" + NEW, flush=True)
        print("V9_GITHUB_HEALTH_AND_CONCURRENCY_CANARY_REQUIRED", flush=True)
    except Exception as exc:
        if stopped:
            try:
                # An old binary must never resume over a new WAITING record.
                quiescence()
                if switched:
                    roll = BASE / (".rollback-v9-" + str(os.getpid()))
                    os.symlink(str(old_dir), roll)
                    os.replace(roll, CURRENT)
                if envchanged:
                    write_atomic(ENVFILE, oldenv)
                exec_safe(["/usr/bin/systemctl", "start", SERVICE], timeout=50)
                print("V9_ROLLBACK_OLD_SERVICE_RESTORED", flush=True)
            except Exception as rollback:
                print("V9_ROLLBACK_BLOCKED=" + str(rollback)[:160], flush=True)
        print("V9_INSTALL_BLOCKED=" + str(exc)[:240], flush=True)
        raise
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
        os.close(lockfd)


if __name__ == "__main__":
    main()
