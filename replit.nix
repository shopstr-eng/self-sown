{ pkgs }: {
    # NOTE: this repl's nixpkgs channel (22.11) only provides up to
    # nodejs-18_x — nodejs-22_x does not exist here and breaks env builds.
    # The actual Node 22 runtime comes from the `nodejs-22` module in .replit;
    # .nvmrc is the source of truth for the Node major the app is built,
    # tested, and published on (enforced by the drift guard in
    # scripts/deploy-build.sh).
    deps = [
        pkgs.nodejs-18_x
    ];
}
