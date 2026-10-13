"""Regression checks for multiple Chrome profiles. Run with unittest."""
import asyncio
import json
import unittest
from unittest.mock import patch

from flowboard.services.flow_client import FlowClient
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
    async def asyncSetUp(self):
        self.client = FlowClient()
        self.patch = patch.object(ws_server, "flow_client", self.client)
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
        self.assertFalse(self.client.connected)
        self.assertIsNone(self.client.user_info)
        self.assertEqual(old.sent[0]["type"], "bridge_rejected")

    async def test_second_profile_cannot_steal_dispatch_or_identity(self):
        a, b = Socket(hello()), Socket(hello("profile-B-00000002"))
        await self.connect(a)
        self.client._user_info = {"email": "selected@example.test"}
        secret = self.client.callback_secret
        await self.connect(b)
        self.assertEqual(b.closed, 4003)
        self.assertTrue(self.client.owns_extension(a))
        self.assertEqual(self.client.callback_secret, secret)
        self.assertEqual(self.client.user_info["email"], "selected@example.test")
        await self.client.notify({"method": "test"})
        self.assertEqual(a.sent[-1]["method"], "test")
        self.assertNotIn("secret", b.sent[0])

    async def test_stale_disconnect_does_not_cancel_active_job(self):
        a, b = Socket(hello()), Socket(hello())
        self.client.set_extension(a)
        future = asyncio.get_running_loop().create_future()
        self.client._pending["job"] = future
        self.client.clear_extension(b)
        self.assertTrue(self.client.connected)
        self.assertFalse(future.done())
        self.client.resolve_callback({"id": "job", "status": 200})
        self.assertEqual((await future)["status"], 200)

    async def test_same_profile_reconnect_rotates_secret_and_keeps_binding(self):
        a = Socket(hello())
        task = await self.connect(a)
        secret = self.client.callback_secret
        await a.inbox.put(None)
        await task
        self.assertFalse(self.client.connected)
        self.assertNotEqual(secret, self.client.callback_secret)
        b = Socket(hello("profile-B-00000002"))
        await self.connect(b)
        self.assertEqual(b.closed, 4003, "disconnect does not authorize account switching")
        again = Socket(hello())
        await self.connect(again)
        self.assertTrue(self.client.owns_extension(again))
        self.assertNotEqual(secret, self.client.callback_secret)
        self.assertEqual(self.client.ws_stats["extension_version"], "0.1.15")

    async def test_rejected_old_connection_cannot_clear_new_connection(self):
        a = Socket(hello())
        await self.connect(a)
        old = Socket({"type": "extension_ready"})
        await self.connect(old)
        self.assertTrue(self.client.owns_extension(a))

    async def test_no_identity_from_socket_cleared_by_logout(self):
        a = Socket(hello())
        task = await self.connect(a)
        self.client.clear_extension()
        await a.inbox.put({"type": "user_info", "userInfo": {"email": "stale@example.test"}})
        await task
        self.assertIsNone(self.client.user_info)


if __name__ == "__main__":
    unittest.main()
