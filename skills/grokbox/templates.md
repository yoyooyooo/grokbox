# Templates

Load only when asked to package, share, or import a template: `grokbox skills get grokbox --topic templates`. This is not part of normal Bot setup.

## Package and review before sharing

```bash
grokbox template pack <agent> --out recipe.json
```

Pack resolves the source Bot through Gateway and reads its local data; it does **not** upload the recipe. Review profile, Memory, skill prose, and any private or machine-specific content before staging. Choose a new output path to avoid replacing an existing file. A local recipe is not a complete backup of the Bot or its accounts.

## Stage, then publish deliberately

```bash
grokbox template stage <agent> --visibility public --from recipe.json --yes
# Keep data.shareId and data.version from the stage receipt.
grokbox template publish <shareId> --rev <n> --yes
```

`stage` must run on the box, but **uploads** an unpublished version; box-local execution does not mean data stays local. Choose `public` or `team` according to the user's sharing scope, not by copying the example blindly. Staging and publishing each require authorization. Use the actual returned version for `--rev`; a stage receipt is not proof of publication. Publish uses Gateway.

## Import a chosen version

```bash
grokbox template import <shareId> --name <name> --rev <n> --yes
```

Import creates a Bot through Gateway. `--rev` is the template version; `--version` reports the grokbox CLI version. Inspect an uncertain create/import outcome before trying again, rather than creating duplicates.

Importing a template does not install the version-matched grokbox skill files. The canonical helper recipe and [template stub](../stubs/grokbox.md) carry a small loader, not recovery procedures. On the destination computer, start with `grokbox skills get grokbox`, then request only the needed `--topic`. Verify the imported Bot and do not assume custom-model eligibility; see [ownership](ownership.md).
