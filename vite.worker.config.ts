import {defineConfig} from 'vite';
import {fileURLToPath} from 'node:url';
import {extensionBuildProfile} from './scripts/extension-build-profile.mjs';

const releaseSha=process.env.RBRIDGE_RELEASE_SHA??process.env.GITHUB_SHA??'';
if(!/^[0-9a-f]{40}$/.test(releaseSha))throw new Error('RBRIDGE_RELEASE_SHA_REQUIRED_FOR_EXTENSION_BUILD');
const profile=extensionBuildProfile();
const entry=fileURLToPath(new URL(profile.profile==='v3'?'./src/extension/serviceWorkerEntryV3.ts':'./src/extension/serviceWorkerEntry.ts',import.meta.url));
export default defineConfig({
  define:{__RBRIDGE_RELEASE_SHA__:JSON.stringify(releaseSha),__RBRIDGE_V3_STARTUP_CONFIG_SHA256__:JSON.stringify(profile.v3ConfigSha256)},
  build:{
    outDir:profile.outDir,emptyOutDir:false,target:'chrome120',minify:false,sourcemap:false,
    lib:{entry,formats:['es'],fileName:()=> 'serviceWorker.js'},
    rollupOptions:{output:{inlineDynamicImports:true}},
  },
});
