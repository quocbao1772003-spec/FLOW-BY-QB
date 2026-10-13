"""Run isolated dispatch checks with stdlib when the local venv lacks pytest."""
import ast
import asyncio
from datetime import datetime, timezone
from pathlib import Path
import sys
from types import ModuleType, SimpleNamespace
from unittest.mock import patch

root = Path(__file__).resolve().parents[1]
source = (root / "flowboard/worker/processor.py").read_text(encoding="utf-8")
compile(source, "processor.py", "exec")
tree = ast.parse(source)
names = {"_new_image_project", "_handle_gen_image", "_handle_edit_image", "reset_image_project_session", "_with_ref_recovery", "_is_ref_not_found"}
selected = ast.Module(body=[n for n in tree.body if isinstance(n, (ast.AsyncFunctionDef, ast.FunctionDef)) and n.name in names], type_ignores=[])
for name in ("flowboard", "flowboard.services", "flowboard.services.flow_sdk", "flowboard.services.media_project_sync"):
    sys.modules[name] = ModuleType(name)
sys.modules["flowboard.services.flow_sdk"].is_valid_project_id = lambda value: len(value) == 36
sys.modules["flowboard.services.media_project_sync"].ensure_media_ids_in_project = None
sys.modules["flowboard.services.media_project_sync"].substitute_cached = lambda ids, project: ids
sys.modules["flowboard.services.media_project_sync"].force_reupload = None

async def recover(project, refs, dispatch):
    return await dispatch(refs)

proc = ModuleType("isolated_processor")
proc.__dict__.update(datetime=datetime, timezone=timezone, asyncio=asyncio, Optional=__import__('typing').Optional,
    Callable=__import__('typing').Callable, Awaitable=__import__('typing').Awaitable,
    logger=__import__('logging').getLogger('checks'), _NOT_FOUND_MARKERS=('RPC_5_NOT_FOUND', 'Requested entity was not found'),
    flow_client=SimpleNamespace(paygate_tier="PAYGATE_TIER_ONE", user_info=None), get_flow_sdk=lambda: None,
    _with_ref_recovery=recover)
exec(compile(selected, "processor.py", "exec"), proc.__dict__)
proc.reset_image_project_session()
tests = ast.parse((root / "tests/test_fresh_image_project.py").read_text(encoding="utf-8"))
tests.body = [n for n in tests.body if not isinstance(n, (ast.Import, ast.ImportFrom))
              or (isinstance(n, ast.ImportFrom) and n.module == "unittest.mock")]
tests.body = [n for n in tests.body if not (isinstance(n, ast.FunctionDef) and n.name == "reset_session")]
for node in tests.body:
    if isinstance(node, ast.AsyncFunctionDef):
        node.decorator_list = []
env = {"proc": proc, "asyncio": asyncio}
exec(compile(tests, "tests", "exec"), env)
for name, function in list(env.items()):
    if name.startswith("test_"):
        proc.reset_image_project_session()
        asyncio.run(function())
        print("PASS", name)
