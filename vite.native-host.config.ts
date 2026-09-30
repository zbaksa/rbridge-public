import {defineConfig} from 'vite';
import {fileURLToPath} from 'node:url';

const entry=fileURLToPath(new URL('./src/nativeHost/nativeHostCli.ts',import.meta.url));
export default defineConfig({
  build:{
    outDir:'dist-native-host',emptyOutDir:true,target:'node22',minify:false,sourcemap:false,
    lib:{entry,formats:['cjs'],fileName:()=> 'rbridge-native-host.cjs'},
    rollupOptions:{
      external:(id)=>id.startsWith('node:'),
      output:{inlineDynamicImports:true},
    },
  },
});
