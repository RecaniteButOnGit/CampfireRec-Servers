# Pinned official CV2 catalog

Source: [CircuitsV2Resources](https://github.com/tyleo-rec/CircuitsV2Resources),
linked as the chip JSON resource by its [Official Resources site](https://tyleo-rec.github.io/CircuitsV2Resources/).
Commit and source paths are recorded in `source.json`; `LICENSE` is the upstream MIT license.

`circuitsv2.json` contains the normal chip palette. `circuitsv2.full.json` additionally
contains hidden and development chips, as documented by the [upstream README](https://github.com/tyleo-rec/CircuitsV2Resources/blob/d4dc2523506862a46844e4c6064bcc2cbc2a08bb/misc/README.md).
Keep both files unchanged so their source hashes can be checked. The runtime imports
the automatically generated `src/cv2-agent/published-catalog.json`, not these files.

To refresh: choose an upstream commit, replace both exports and license with files
from that commit, update `source.json`, run `node apps/discovery/cv2-schema/generate.mjs`
from the repository root, and review/test the generated changes. Agent requests do
not fetch remote metadata. Catalog descriptors do not supply universal chip defaults
or complete serialized creation templates.
