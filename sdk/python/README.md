# nbus-client (Python)

Async Python SDK for the [nbus](../../PROTOCOL.md) local IPC bus daemon.
Core transport + primitives only — no crypto yet.

```python
from nbus import NBus

async with NBus("/tmp/nbus.sock") as bus:
    await bus.set("app", "version", "1.2.3")
    print(await bus.get("app", "version"))      # "1.2.3"
    await bus.emit("deploy", "done", {"v": "1.2.3"})

    async for event in bus.listen("deploy", "done"):
        print(event)  # {"bucket": ..., "event": ..., "data": ...}
```

## Develop

```sh
uv sync
uv run pytest -q   # boots the real Bun daemon and replays wire vectors
```
