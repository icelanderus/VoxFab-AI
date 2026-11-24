const fs = require('fs');
const path = require('path');
const ResEdit = require('resedit');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;
  const exePath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`);
  const icoPath = path.resolve(__dirname, '../assets/icon.ico');
  if (!fs.existsSync(exePath) || !fs.existsSync(icoPath)) return;

  console.log(`  • embedding VoxFab AI icon into ${exePath}`);
  const data = fs.readFileSync(exePath);
  const exe = ResEdit.NtExecutable.from(data, { ignoreCert: true });
  const res = ResEdit.NtExecutableResource.from(exe);
  const iconFile = ResEdit.Data.IconFile.from(fs.readFileSync(icoPath));

  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
    res.entries,
    1,
    1033,
    iconFile.icons.map((i) => i.data)
  );

  res.outputResource(exe);
  fs.writeFileSync(exePath, Buffer.from(exe.generate()));
};
