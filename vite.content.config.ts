import {defineConfig} from 'vite';
import {fileURLToPath} from 'node:url';
import {extensionBuildProfile} from './scripts/extension-build-profile.mjs';

const entry=fileURLToPath(new URL('./src/extension/contentScriptEntry.ts',import.meta.url));
export default defineConfig({
  build:{
    outDir:extensionBuildProfile().outDir,emptyOutDir:true,target:'chrome120',minify:false,sourcemap:false,
    lib:{entry,name:'CocwinRbridgeContent',formats:['iife'],fileName:()=> 'contentScript.js'},
  },
});
