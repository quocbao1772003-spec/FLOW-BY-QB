"""Regression checks for multiple Chrome profiles. Run with unittest."""
import asyncio
import json
import unittest
from unittest.mock import patch

import tempfile
from pathlib import Path

from flowboard.services.account_pool import AccountPool
from flowboard.services import ws_server


class Socket:
    def __init__(self, hello):
        self.hello = hello
        self.sent = []
        self.inbox = asyncio.Queue()
        self.closed = None

    async def recv(self):
        return json.dumps(self.hello)

    async def send(self, raw):
        self.sent.append(json.loads(raw))

    async def close(self, code, reason):
        self.closed = code

    def __aiter__(self):
        return self

    async def __anext__(self):
        value = await self.inbox.get()
        if value is None:
            raise StopAsyncIteration
        return json.dumps(value)


def hello(profile="profile-A-00000001"):
    return {"type": "bridge_hello", "protocol": 2,
            "instanceId": profile, "version": "0.1.15"}


class BridgeProfiles(unittest.IsolatedAsyncioTestCase):
    """Every Chrome profile is its own Google Flow account; all may connect."""

    async def asyncSetUp(self):
        self.pool = AccountPool(state_path=Path(tempfile.mkdtemp()) / "accounts.json")
        self.patch = patch.object(ws_server, "pool", self.pool)
        self.patch.start()
        self.tasks = []

    async def asyncTearDown(self):
        for task in self.tasks:
            task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)
        self.patch.stop()

    async def connect(self, socket):
        task = asyncio.create_task(ws_server._handler(socket))
        self.tasks.append(task)
        for _ in range(20):
            await asyncio.sleep(0)
            if socket.sent or task.done():
                break
        return task

    async def test_old_extension_never_receives_secret_or_becomes_active(self):
        old = Socket({"type": "user_info", "userInfo": {"email": "old@example.test"}})
        await self.connect(old)
        self.assertEqual(old.closed, 4002)
        self.assertEqual(self.pool.connected_clients(), [])
        self.assertFalse(self.pool.current().connected)
        self.assertEqual(old.sent[0]["type"], "bridge_rejected")

    async def test_two_profiles_connect_with_own_identity_and_secret(self):
        a, b = Socket(hello()), Socket(hello("profile-B-00000002"))
        await self.connect(a)
        await self.connect(b)
        self.assertIsNone(b.closed)
        ca, cb = self.pool.client_for_ws(a), self.pool.client_for_ws(b)
        self.assertIsNot(ca, cb)
        self.assertNotEqual(a.sent[0]["secret"], b.sent[0]["secret"])
        await a.inbox.put({"type": "user_info", "userInfo": {"email": "A@x.test"}})
        await b.inbox.put({"type": "user_info", "userInfo": {"email": "b@x.test"}})
        for _ in range(10):
            await asyncio.sleep(0)
        self.assertEqual(self.pool.key_of(ca), "a@x.test")
        self.assertEqual(self.pool.key_of(cb), "b@x.test")
        self.assertEqual(self.pool.primary, "a@x.test")
        # A callback with A's secret resolves only A's pending call.
        fut = asyncio.get_running_loop().create_future()
        ca._pending["job"] = fut
        self.assertFalse(self.pool.resolve_callback({"id": "job", "status": 200}, b.sent[0]["secret"]))
        self.assertTrue(self.pool.resolve_callback({"id": "job", "status": 200}, a.sent[0]["secret"]))
        self.assertEqual((await fut)["status"], 200)
        self.assertIsNone(self.pool.resolve_callback({"id": "x"}, "wrong-secret"))

    async def test_stale_disconnect_does_not_cancel_active_job(self):
        a = Socket(hello())
        await self.connect(a)
        client = self.pool.client_for_ws(a)
        future = asyncio.get_running_loop().create_future()
        client._pending["job"] = future
        self.pool.detach(Socket(hello()))
        self.assertTrue(client.connected)
        self.assertFalse(future.done())
        client.resolve_callback({"id": "job", "status": 200})
        self.assertEqual((await future)["status"], 200)

    async def test_same_profile_reconnect_rotates_secret_and_keeps_binding(self):
        a = Socket(hello())
        task = await self.connect(a)
        client = self.pool.client_for_ws(a)
        secret = client.callback_secret
        await a.inbox.put(None)
        await task
        self.assertFalse(client.connected)
        again = Socket(hello())
        await self.connect(again)
        self.assertIs(self.pool.client_for_ws(again), client, "same profile, same account slot")
        self.assertNotEqual(secret, client.callback_secret)
        self.assertEqual(client.ws_stats["extension_version"], "0.1.15")

    async def test_rejected_old_connection_cannot_clear_new_connection(self):
        a = Socket(hello())
        await self.connect(a)
        old = Socket({"type": "extension_ready"})
        await self.connect(old)
        self.assertTrue(self.pool.client_for_ws(a).owns_extension(a))

    async def test_no_identity_from_socket_cleared_by_logout(self):
        a = Socket(hello())
        task = await self.connect(a)
        client = self.pool.client_for_ws(a)
        client.clear_extension()
        await a.inbox.put({"type": "user_info", "userInfo": {"email": "stale@example.test"}})
        await task
        self.assertIsNone(client.user_info)


if __name__ == "__main__":
    unittest.main()
