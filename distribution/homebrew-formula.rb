# Homebrew Formula template for orrith.
# Place at github.com/orrith/homebrew-orrith/Formula/orrith.rb
#
# After publishing: brew tap orrith/orrith && brew install orrith

class Orrith < Formula
  desc "The ops cockpit for solo builders — HUD with multi-source metrics + 5 aesthetic presets"
  homepage "https://orrith.dev"
  url "https://registry.npmjs.org/orrith/-/orrith-VERSION.tgz"  # FIXME: replace VERSION
  sha256 "FIXME"  # sha256 of the tarball
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", *Language::Node.std_npm_install_args(libexec)
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  test do
    system "#{bin}/orrith", "--version"
  end
end
