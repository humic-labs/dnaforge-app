const { notarizeApp } = require('./notarize-app.cjs');
const { decideAfterSignNotarize } = require('./lib/notarize-helpers.cjs');

exports.default = async function notarizing(context) {
  const decision = decideAfterSignNotarize(context, process.env);
  if (decision.skip) {
    console.log(`Skipping notarization — ${decision.reason}`);
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  await notarizeApp({ appPath: `${context.appOutDir}/${appName}.app` });
};
