import {pathToFileURL} from 'node:url';

// RED scaffold only. It loads the behavioral suite without manufacturing a
// fixture inventory or admitting a production byte/provenance capability.
export async function collectStagedArtifactFixtureInventory(fixtureBinding) {
  void fixtureBinding;
  throw new Error('SOURCE_ARTIFACT_ACQUISITION_BINDING_UNAVAILABLE');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stderr.write('SOURCE_ARTIFACT_ACQUISITION_BINDING_UNAVAILABLE\n');
  process.exitCode = 70;
}
