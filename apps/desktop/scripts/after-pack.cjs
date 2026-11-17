const path = require('node:path');
const { Arch } = require('builder-util');
const { stageDesktopCli } = require('./lib/desktop-cli.cjs');
const { default: finishNativeResources } = require('./dedup-dugite.cjs');
const { collectAppOwnedToolSources } = require('./lib/app-owned-tool-sources.cjs');
const { installSigningHandoff } = require('./lib/app-owned-signing-handoff.cjs');
const { buildMacUpdateStatusHelper } = require('./update-status-packaging.cjs');
const { relocateMacHelperMetadata } = require('./lib/mac-helper-metadata.cjs');
const { stageMacosVulkanLoader } = require('./lib/macos-vulkan-loader.cjs');

exports.default = async function afterPack(context, { inspectSigningPublisher } = {}) {
  const platform = context.electronPlatformName;
  const resourcesDir =
    platform === 'darwin'
      ? path.join(
          context.appOutDir,
          `${context.packager.appInfo.productFilename}.app`,
          'Contents',
          'Resources'
        )
      : path.join(context.appOutDir, 'resources');
  const arch = typeof context.arch === 'number' ? Arch[context.arch] : context.arch;
  stageDesktopCli({ resourcesDir, platform, arch });
  await finishNativeResources(context);
  buildMacUpdateStatusHelper(context, path.resolve(__dirname, '..'));
  if (platform === 'darwin') {
    const appPath = path.dirname(path.dirname(resourcesDir));
    stageMacosVulkanLoader({
      appPath,
      arch,
      sourceDir: process.env.DNAFORGE_MACOS_VULKAN_LOADER_DIR,
      applicationSourceSha: process.env.RELEASE_SOURCE_SHA,
      packagingControllerSha: process.env.GITHUB_SHA,
      recipeSha256: process.env.DNAFORGE_PACKAGING_RECIPE_SHA256,
      required: process.env.DNAFORGE_MACOS_VULKAN_LOADER_REQUIRED === '1',
    });
    relocateMacHelperMetadata(appPath);
    const sources = collectAppOwnedToolSources({ appPath, arch });
    if (sources.length) {
      await installSigningHandoff({
        packager: context.packager,
        appPath,
        bundleIdentifier: context.packager.appInfo.macBundleIdentifier,
        sources,
        inspect: inspectSigningPublisher,
      });
    }
  }
};
