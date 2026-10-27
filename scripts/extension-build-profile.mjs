// The V3 document pin is a trusted build input, never inferred from Chrome data.
export function extensionBuildProfile(env=process.env){
  const profile=env.RBRIDGE_EXTENSION_PROFILE??'v1',pin=env.RBRIDGE_V3_STARTUP_CONFIG_SHA256;
  if(profile!=='v1'&&profile!=='v3')throw Error('RBRIDGE_EXTENSION_BUILD_PROFILE_INVALID');
  if(profile==='v3'&&(typeof pin!=='string'||!/^[a-f0-9]{64}$/.test(pin)))throw Error('RBRIDGE_EXTENSION_V3_BUILD_PIN_REQUIRED');
  if(profile==='v1'&&pin!==undefined)throw Error('RBRIDGE_EXTENSION_V3_PIN_UNEXPECTED');
  return {profile,outDir:profile==='v3'?'dist-extension-v3':'dist-extension',v3ConfigSha256:profile==='v3'?pin:null};
}
