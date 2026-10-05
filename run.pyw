"""Double-clickable launcher from source (no console window on Windows)."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mediainspector.app import main  # noqa: E402

sys.exit(main())
