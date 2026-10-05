"""Background work: analysis and exports off the UI thread, cancellable,
with progress. Opening another file cancels the jobs that belong to the old
one; exports keep running."""

from __future__ import annotations

import threading
import traceback
from typing import Any, Callable

from PySide6.QtCore import QObject, QRunnable, QThreadPool, Signal

from .decode import Stop


class _Signals(QObject):
    progress = Signal(float)
    done = Signal(object)
    failed = Signal(str)
    cancelled = Signal()


class _Job(QRunnable):
    def __init__(self, fn: Callable, args: tuple, token: threading.Event):
        super().__init__()
        self.fn, self.args, self.token = fn, args, token
        self.s = _Signals()

    def run(self):
        try:
            result = self.fn(*self.args, cancelled=self.token.is_set, progress=self.s.progress.emit)
        except Stop:
            self.s.cancelled.emit()
        except Exception as e:  # noqa: BLE001 - a job's failure is reported, never fatal
            traceback.print_exc()
            self.s.failed.emit(str(e) or e.__class__.__name__)
        else:
            if self.token.is_set():
                self.s.cancelled.emit()
            else:
                self.s.done.emit(result)


class Jobs(QObject):
    busy_changed = Signal(str, bool)       # job name, running

    def __init__(self, parent=None):
        super().__init__(parent)
        self.pool = QThreadPool(self)
        self.pool.setMaxThreadCount(3)
        self._tokens: dict[str, threading.Event] = {}
        self._groups: dict[str, str] = {}
        self._keep: dict[str, _Job] = {}

    def running(self, name: str) -> bool:
        return name in self._tokens

    def run(self, name: str, fn: Callable, *args: Any, group: str = "",
            on_done: Callable | None = None, on_fail: Callable | None = None,
            on_progress: Callable | None = None) -> None:
        """One job per name: a new one replaces (cancels) the last."""
        self.cancel(name)
        token = threading.Event()
        job = _Job(fn, args, token)
        self._tokens[name], self._groups[name], self._keep[name] = token, group, job

        def finish():
            if self._tokens.get(name) is token:
                del self._tokens[name]
                self._groups.pop(name, None)
                self._keep.pop(name, None)
                self.busy_changed.emit(name, False)

        def done(r):
            current = self._tokens.get(name) is token
            finish()
            if current and on_done:
                on_done(r)

        def failed(msg):
            current = self._tokens.get(name) is token
            finish()
            if current and on_fail:
                on_fail(msg)

        job.s.done.connect(done)
        job.s.failed.connect(failed)
        job.s.cancelled.connect(finish)
        if on_progress:
            job.s.progress.connect(lambda f: self._tokens.get(name) is token and on_progress(f))
        self.busy_changed.emit(name, True)
        self.pool.start(job)

    def cancel(self, name: str) -> None:
        token = self._tokens.pop(name, None)
        if token:
            token.set()
            self._groups.pop(name, None)
            self.busy_changed.emit(name, False)

    def cancel_group(self, group: str) -> None:
        for name, g in list(self._groups.items()):
            if g == group:
                self.cancel(name)

    def wait(self, ms: int = -1) -> bool:
        return self.pool.waitForDone(ms)
