"""Admin commands.

    python -m flowboard.manage create-admin <username> [password]
    python -m flowboard.manage reset-password <username> [password]
    python -m flowboard.manage list-users

Creating the first admin turns on login for the whole app.
"""
from __future__ import annotations

import sys

from sqlmodel import select

from flowboard.db import get_session, init_db
from flowboard.db.models import User
from flowboard.services import users


def main(argv: list[str]) -> int:
    init_db()
    if len(argv) < 2 or argv[1] not in ("create-admin", "reset-password", "list-users"):
        print(__doc__)
        return 1
    cmd = argv[1]
    if cmd == "list-users":
        with get_session() as s:
            for u in s.exec(select(User)).all():
                print(f"{u.id:>3}  {u.username:<20} {u.role:<6} {'KHOA' if u.disabled else ''}")
        return 0
    if len(argv) < 3:
        print("Thieu ten dang nhap")
        return 1
    name = users.normalize_username(argv[2])
    password = argv[3] if len(argv) > 3 else users.generate_password()
    if cmd == "create-admin":
        try:
            users.create_user(name, password, role="admin", display_name=name)
        except ValueError as exc:
            print(f"Loi: {exc}")
            return 1
        print(f"Da tao admin: {name}")
    else:
        with get_session() as s:
            u = s.exec(select(User).where(User.username == name)).first()
            if u is None:
                print("Khong thay tai khoan")
                return 1
            u.password_hash = users.hash_password(password)
            u.disabled = False
            s.add(u)
            s.commit()
            users.drop_sessions(u.id)
        print(f"Da dat lai mat khau cho {name}")
    print(f"Mat khau: {password}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
