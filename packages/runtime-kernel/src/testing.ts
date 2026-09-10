export {
  createCountedSeams,
  fakeAdmissionAuthorityLayer,
  fakeBackendAuthLayer,
  fakeConfigurationReadLayer,
  fakeModelBackendLayer,
  fakeControlResourcesLayer,
  fakeHostCompactLayer,
  emptyFakeControlCounts,
  peekFakeSecret,
  unsealFakeAuth,
  type CountedSeams,
  type FakeControlCounts,
} from "./internal/testing/fakes.ts";
