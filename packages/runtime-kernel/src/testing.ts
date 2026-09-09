export {
  createCountedSeams,
  fakeAdmissionAuthorityLayer,
  fakeBackendAuthLayer,
  fakeConfigurationReadLayer,
  fakeModelBackendLayer,
  fakeControlResourcesLayer,
  emptyFakeControlCounts,
  peekFakeSecret,
  unsealFakeAuth,
  type CountedSeams,
  type FakeControlCounts,
} from "./internal/testing/fakes.ts";
