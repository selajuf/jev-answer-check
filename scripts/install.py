#!/usr/bin/env python3
"""Install only this package's MCP, hooks and skill; preserve other settings."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import stat
import tempfile
import tomllib


def atomic_write(path, content, old_bytes=None):
    path.parent.mkdir(parents=True, exist_ok=True)
    current = path.read_bytes() if path.exists() else None
    if old_bytes is not None and current != old_bytes:
        raise RuntimeError(f"Configuration changed concurrently: {path.name}")
    mode = stat.S_IMODE(path.stat().st_mode) if path.exists() else 0o600
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=path.name + ".")
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, "wb") as stream:
            stream.write(content.encode("utf-8"))
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def merge_hooks(data, command):
    hooks = data.setdefault("hooks", {})
    for event in ("UserPromptSubmit", "Stop"):
        entries = hooks.setdefault(event, [])
        for entry in entries:
            entry["hooks"] = [hook for hook in entry.get("hooks", [])
                              if "src/hook.mjs" not in hook.get("command", "")
                              or "jev-answer-check" not in hook.get("command", "")]
        entries[:] = [entry for entry in entries if entry.get("hooks")]
        entries.append({"hooks": [{"type": "command", "command": command, "timeout": 5}]})
    return data


def mcp_toml(text, node, server):
    lines = text.splitlines(keepends=True)
    result = []
    drop = False
    for line in lines:
        if line.lstrip().startswith("["):
            match = re.match(r"\s*\[([^\]]+)\]", line)
            section = match.group(1) if match else ""
            drop = section == "mcp_servers.jev_answer_check" or section.startswith("mcp_servers.jev_answer_check.")
        if not drop:
            result.append(line)
    q = lambda value: json.dumps(value, ensure_ascii=False)
    block = f'''\n[mcp_servers.jev_answer_check]
command = {q(node)}
args = [{q(str(server))}, "--host", "codex"]
enabled_tools = ["jev_check_answer"]
startup_timeout_sec = 10
tool_timeout_sec = 25

[mcp_servers.jev_answer_check.tools.jev_check_answer]
approval_mode = "approve"
'''
    new = "".join(result).rstrip() + "\n" + block
    tomllib.loads(new)
    return new


def prompt_text(text, skill, host):
    line = f"- **clear-report** — ясный русский отчет, наглядная форма и проверка Jev перед финальным ответом. Инструкция: `{skill}`."
    if re.search(r"(?m)^- \*\*clear-report\*\*.*$", text):
        text = re.sub(r"(?m)^- \*\*clear-report\*\*.*$", lambda _: line, text)
    else:
        text = text.rstrip() + "\n\n# Clear report\n\n" + line + "\n"
    text = text.replace("Перед отчетом о проделанной работе обязательно прочитай и примени", "Перед содержательным отчетом или объяснением обязательно прочитай и примени")
    final_line = "Перед содержательным финальным ответом используй clear-report и MCP jev_check_answer."
    if "# Финальный ответ" not in text and final_line not in text:
        text += "\n" + final_line + "\n"
    return text


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--home", type=Path, default=Path.home())
    parser.add_argument("--repo", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--node", default=shutil.which("node") or "node")
    parser.add_argument("--hosts", nargs="+", choices=["codex", "claude"], default=["codex", "claude"])
    parser.add_argument("--key-source", type=Path)
    parser.add_argument("--enable", action="store_true")
    args = parser.parse_args()
    home, repo = args.home.resolve(), args.repo.resolve()
    config_dir = home / ".config/jev-answer-check"
    state_dir = home / ".local/state/jev-answer-check"
    config_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    backup = state_dir / "backups" / stamp
    backup.mkdir(parents=True, mode=0o700)
    plans = []

    def plan_json(path, transform):
        old = path.read_bytes() if path.exists() else None
        data = json.loads(old) if old else {}
        plans.append((path, json.dumps(transform(data), ensure_ascii=False, indent=2) + "\n", old))

    if "codex" in args.hosts:
        cfg = home / ".codex/config.toml"
        old = cfg.read_bytes() if cfg.exists() else None
        plans.append((cfg, mcp_toml(old.decode() if old else "", args.node, repo / "src/mcp.mjs"), old))
        command = " ".join(map(shlex.quote, [args.node, str(repo / "src/hook.mjs"), "--host", "codex"]))
        plan_json(home / ".codex/hooks.json", lambda data: merge_hooks(data, command))
    if "claude" in args.hosts:
        entry = {"type": "stdio", "command": args.node, "args": [str(repo / "src/mcp.mjs"), "--host", "claude"]}
        def claude_mcp(data):
            data.setdefault("mcpServers", {})["jev_answer_check"] = entry
            return data
        plan_json(home / ".claude.json", claude_mcp)
        command = " ".join(map(shlex.quote, [args.node, str(repo / "src/hook.mjs"), "--host", "claude"]))
        def claude_settings(data):
            merge_hooks(data, command)
            allow = data.setdefault("permissions", {}).setdefault("allow", [])
            permission = "mcp__jev_answer_check__jev_check_answer"
            if permission not in allow:
                allow.append(permission)
            return data
        plan_json(home / ".claude/settings.json", claude_settings)
    for host in args.hosts:
        prompt = home / (".codex/AGENTS.md" if host == "codex" else ".claude/CLAUDE.md")
        old = prompt.read_bytes() if prompt.exists() else None
        skill = home / f".{host}/skills/clear-report/SKILL.md"
        plans.append((prompt, prompt_text(old.decode() if old else "", skill, host), old))

    manifest = []
    for index, (path, content, old) in enumerate(plans):
        if old is not None:
            saved = backup / f"{index}-{path.name}"
            saved.write_bytes(old)
            saved.chmod(0o600)
        manifest.append({"path": str(path), "before_sha256": hashlib.sha256(old).hexdigest() if old is not None else None})
        atomic_write(path, content, old)
    for host in args.hosts:
        target = home / f".{host}/skills/clear-report"
        if target.exists():
            shutil.copytree(target, backup / f"{host}-clear-report")
        shutil.copytree(repo / "skills/clear-report", target, dirs_exist_ok=True)
    if args.key_source:
        key = args.key_source.read_bytes()
        if not key.strip():
            raise RuntimeError("Empty key source")
        key_file = config_dir / "api-key"
        fd, temp = tempfile.mkstemp(dir=config_dir, prefix="key.")
        with os.fdopen(fd, "wb") as stream:
            stream.write(key)
        os.chmod(temp, 0o600)
        os.replace(temp, key_file)
    cfg_path = config_dir / "config.json"
    cfg = json.loads(cfg_path.read_text()) if cfg_path.exists() else {}
    cfg.setdefault("dailyBudgetUsd", 0.05)
    cfg.setdefault("maxRequestUsd", 0.004)
    cfg["maxCallsPerTurn"] = 2
    cfg["enabled"] = args.enable
    atomic_write(cfg_path, json.dumps(cfg, indent=2) + "\n")
    (backup / "manifest.json").write_text(json.dumps(manifest, indent=2))
    (backup / "manifest.json").chmod(0o600)
    print(json.dumps({"installed": args.hosts, "repo": str(repo), "backup": str(backup), "enabled": cfg["enabled"], "dailyBudgetUsd": cfg["dailyBudgetUsd"]}))


if __name__ == "__main__":
    main()
