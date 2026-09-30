import {defineConfig} from 'vite';
import {fileURLToPath} from 'node:url';

const releaseSha=process.env.RBRIDGE_RELEASE_SHA??process.env.GITHUB_SHA??'';
if(!/^[0-9a-f]{40}$/.test(releaseSha))throw new Error('RBRIDGE_RELEASE_SHA_REQUIRED_FOR_EXTENSION_BUILD');
const entry=fileURLToPath(new URL('./src/extension/serviceWorkerEntry.ts',import.meta.url));
export default defineConfig({
  define:{__RBRIDGE_RELEASE_SHA__:JSON.stringify(releaseSha)},
  build:{
    outDir:'dist-extension',emptyOutDir:false,target:'chrome120',minify:false,sourcemap:false,
    lib:{entry,formats:['es'],fileName:()=> 'serviceWorker.js'},
    rollupOptions:{output:{inlineDynamicImports:true}},
  },
});
