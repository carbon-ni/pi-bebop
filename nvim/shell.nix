{ pkgs ? import <nixpkgs> {} }:

pkgs.mkShell {
  packages = with pkgs; [
    lua5_1
    lua51Packages.busted
    lua51Packages.luacheck
    neovim
  ];

  shellHook = ''
    echo "pi-intray.nvim dev shell"
    echo "Available: make lint, make test, make test-local-nvim"
  '';
}
