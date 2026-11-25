"""Check the version users actually install, before uploading a CI artifact."""

from io import BytesIO
import json
from pathlib import Path
import sys
from xml.etree import ElementTree as ET
from zipfile import ZipFile


def require(condition, message):
    if not condition:
        raise SystemExit(message)


def verify(path, version):
    with ZipFile(path) as archive:
        require(archive.testzip() is None, f"Invalid archive: {path}")
        if path.suffix == ".vsix":
            manifest = json.loads(archive.read("extension/package.json"))
            identity = ET.fromstring(archive.read("extension.vsixmanifest")).find(".//{*}Identity")
            require(
                manifest["version"] == version and identity is not None
                and identity.get("Version") == version,
                f"VSIX version does not match {version}",
            )
        else:
            require(path.name == f"hoosage-jetbrains-{version}.zip",
                    f"Expected JetBrains ZIP for version {version}, got {path.name}")
            jar = f"hoosage-jetbrains/lib/hoosage-jetbrains-{version}.jar"
            with ZipFile(BytesIO(archive.read(jar))) as plugin:
                descriptor = ET.fromstring(plugin.read("META-INF/plugin.xml"))
                require(descriptor.findtext("id") == "ai.openhoo.hoosage.jetbrains"
                        and descriptor.findtext("version") == version,
                        f"Packaged JetBrains descriptor does not match {version}")
    print(f"Verified {path.name} ({version})")


if __name__ == "__main__":
    version = json.loads((Path(__file__).resolve().parents[1] / "package.json").read_text())["version"]
    require(len(sys.argv) > 1, "Pass a built VSIX or JetBrains ZIP")
    for argument in sys.argv[1:]:
        verify(Path(argument), version)
