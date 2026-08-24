#!/usr/bin/env python3
"""Read one var out of wrangler.jsonc for a given env.

Usage: read-wrangler-var.py <env> <VAR>
Prints the value, or nothing and exits 1 if absent. Exits 2 if the file cannot
be parsed, so a caller can tell "not set" apart from "I could not tell".

Naive comment stripping is why this exists: a regex removing `//` to end-of-line
also destroys every https:// URL in the file, and the parse then fails. A safety
check that cannot parse its input must say so rather than guess.
"""
import json
import sys


def strip_jsonc(text: str) -> str:
    out, i, n = [], 0, len(text)
    in_string = escaped = False
    while i < n:
        c = text[i]
        if in_string:
            out.append(c)
            if escaped:
                escaped = False
            elif c == "\\":
                escaped = True
            elif c == '"':
                in_string = False
            i += 1
            continue
        if c == '"':
            in_string = True
            out.append(c)
            i += 1
            continue
        if c == "/" and i + 1 < n and text[i + 1] == "/":
            while i < n and text[i] != "\n":
                i += 1
            continue
        if c == "/" and i + 1 < n and text[i + 1] == "*":
            i += 2
            while i + 1 < n and not (text[i] == "*" and text[i + 1] == "/"):
                i += 1
            i += 2
            continue
        out.append(c)
        i += 1
    stripped = "".join(out)
    # Trailing commas are legal in jsonc and not in json.
    result, i, n = [], 0, len(stripped)
    in_string = escaped = False
    while i < n:
        c = stripped[i]
        if in_string:
            result.append(c)
            if escaped:
                escaped = False
            elif c == "\\":
                escaped = True
            elif c == '"':
                in_string = False
            i += 1
            continue
        if c == '"':
            in_string = True
            result.append(c)
            i += 1
            continue
        if c == ",":
            j = i + 1
            while j < n and stripped[j] in " \t\r\n":
                j += 1
            if j < n and stripped[j] in "}]":
                i += 1
                continue
        result.append(c)
        i += 1
    return "".join(result)


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: read-wrangler-var.py <env> <VAR>", file=sys.stderr)
        return 2
    env_name, var = sys.argv[1], sys.argv[2]
    try:
        cfg = json.loads(strip_jsonc(open("wrangler.jsonc").read()))
    except Exception as exc:
        print(f"could not parse wrangler.jsonc: {exc}", file=sys.stderr)
        return 2
    try:
        value = cfg["env"][env_name]["vars"].get(var)
    except KeyError:
        return 1
    if value in (None, ""):
        return 1
    print(value)
    return 0


if __name__ == "__main__":
    sys.exit(main())
