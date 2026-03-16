import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'storage/index': 'src/storage/index.ts',
    'events/index': 'src/events/index.ts',
    'scheduler/index': 'src/scheduler/index.ts',
  },
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
});
