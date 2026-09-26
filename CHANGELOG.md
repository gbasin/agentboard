# Changelog

## [0.18.0](https://github.com/gbasin/agentboard/compare/v0.17.3...v0.18.0) (2026-09-26)


### Features

* data-dir instance lock; stabilize session list drag-and-drop ([3888f43](https://github.com/gbasin/agentboard/commit/3888f43ea6a42b53eaf1ebb46d581d014fff72aa))
* refuse to share a data dir between agentboard servers ([3888f43](https://github.com/gbasin/agentboard/commit/3888f43ea6a42b53eaf1ebb46d581d014fff72aa))


### Bug Fixes

* commit drops released over the dragged row's own rect ([3888f43](https://github.com/gbasin/agentboard/commit/3888f43ea6a42b53eaf1ebb46d581d014fff72aa))
* stabilize session list drag-and-drop ([3888f43](https://github.com/gbasin/agentboard/commit/3888f43ea6a42b53eaf1ebb46d581d014fff72aa))

## [0.17.3](https://github.com/gbasin/agentboard/compare/v0.17.2...v0.17.3) (2026-09-26)


### Bug Fixes

* position mobile drawer scroll before open, not after it lands ([#302](https://github.com/gbasin/agentboard/issues/302)) ([9421d38](https://github.com/gbasin/agentboard/commit/9421d38ba53d3a26981e356cf641069fcee971b3))

## [0.17.2](https://github.com/gbasin/agentboard/compare/v0.17.1...v0.17.2) (2026-09-26)


### Bug Fixes

* **ci:** keep bun.lock resolvable during the release window ([#300](https://github.com/gbasin/agentboard/issues/300)) ([771af30](https://github.com/gbasin/agentboard/commit/771af301ad06b91c96b53c7b78f8a47a69c188b0))

## [0.17.1](https://github.com/gbasin/agentboard/compare/v0.17.0...v0.17.1) (2026-09-25)


### Bug Fixes

* defer session-list scroll-to-selection until mobile drawer is open ([#298](https://github.com/gbasin/agentboard/issues/298)) ([185a65c](https://github.com/gbasin/agentboard/commit/185a65cf95749cba4555e97746a3b3b50301f75d))

## [0.17.0](https://github.com/gbasin/agentboard/compare/v0.16.0...v0.17.0) (2026-09-25)


### Features

* scroll selected session into view on selection change ([#296](https://github.com/gbasin/agentboard/issues/296)) ([b40a090](https://github.com/gbasin/agentboard/commit/b40a0909355f405249b83973171c7d6a1041fbde))

## [0.16.0](https://github.com/gbasin/agentboard/compare/v0.15.0...v0.16.0) (2026-09-25)


### Features

* enlarge status rail and make the identity group interactive ([#294](https://github.com/gbasin/agentboard/issues/294)) ([d9a7366](https://github.com/gbasin/agentboard/commit/d9a7366ebfcbb921d57a50ab1b9878f3c1f1c959))

## [0.15.0](https://github.com/gbasin/agentboard/compare/v0.14.1...v0.15.0) (2026-09-25)


### Features

* bottom status rail with session context and PR chips ([#290](https://github.com/gbasin/agentboard/issues/290)) ([d26eeef](https://github.com/gbasin/agentboard/commit/d26eeef4d97ed5bc00f17c94cc6816b83d1f2ac5))


### Bug Fixes

* require brief hover intent before PR chip cards open ([#291](https://github.com/gbasin/agentboard/issues/291)) ([927400b](https://github.com/gbasin/agentboard/commit/927400b5e3ce1e7bdfbed1e66d6483bc3456dc42))
* **tests:** de-flake double-attach dedup test ([#292](https://github.com/gbasin/agentboard/issues/292)) ([953ef7c](https://github.com/gbasin/agentboard/commit/953ef7cf94faf6bf5f97205f085280f202d8f8dd))

## [0.14.1](https://github.com/gbasin/agentboard/compare/v0.14.0...v0.14.1) (2026-09-24)


### Bug Fixes

* let outlier sync spawns bypass the slow-spawn rate limiter ([#288](https://github.com/gbasin/agentboard/issues/288)) ([4671d40](https://github.com/gbasin/agentboard/commit/4671d409c4ddc4a941c098482133c8684806db51))

## [0.14.0](https://github.com/gbasin/agentboard/compare/v0.13.0...v0.14.0) (2026-09-24)


### Features

* **matcher:** match windows via AskUserQuestion answer recaps ([#282](https://github.com/gbasin/agentboard/issues/282)) ([9a24e4d](https://github.com/gbasin/agentboard/commit/9a24e4d640985cec5c8a2ec075e43116bb7e26bb))


### Performance Improvements

* make devin session sync incremental ([#285](https://github.com/gbasin/agentboard/issues/285)) ([9d28d18](https://github.com/gbasin/agentboard/commit/9d28d18e3dd363446eba4f446591d373fd328c9e))
* move devin session sync off main thread; add stall instrumentation ([#281](https://github.com/gbasin/agentboard/issues/281)) ([02d9a0e](https://github.com/gbasin/agentboard/commit/02d9a0e187c970ed71aa54abe3aad513c1f6dee3))
* skip tmux reconfigure on refresh ticks while the server is unchanged ([#284](https://github.com/gbasin/agentboard/issues/284)) ([5e2d130](https://github.com/gbasin/agentboard/commit/5e2d130ecbfb34fdf6f236de0a88320122ca3d19))

## [0.13.0](https://github.com/gbasin/agentboard/compare/v0.12.2...v0.13.0) (2026-09-23)


### Features

* attribute subagent-created PRs to parent sessions ([#279](https://github.com/gbasin/agentboard/issues/279)) ([4a0574e](https://github.com/gbasin/agentboard/commit/4a0574e6b6b37d6d175062cd0e17e5192a9a6de5))
* sync theme and shared settings server-side across clients ([#275](https://github.com/gbasin/agentboard/issues/275)) ([dab8070](https://github.com/gbasin/agentboard/commit/dab8070e94850a9ab30aea721bc4758b3f828d13))


### Bug Fixes

* detect gh pr create after escaped newlines in commands ([#274](https://github.com/gbasin/agentboard/issues/274)) ([b1ca734](https://github.com/gbasin/agentboard/commit/b1ca734b098f2e6f8383d40ae2d1eb279f1ff81f))
* stop PR chip false positives from devin logs and non-shell tool calls ([#273](https://github.com/gbasin/agentboard/issues/273)) ([2f04051](https://github.com/gbasin/agentboard/commit/2f040519f6e951366288203101134efcf0b89e39))
* sync bun.lock on master after each release publish ([#280](https://github.com/gbasin/agentboard/issues/280)) ([869ea02](https://github.com/gbasin/agentboard/commit/869ea02a25e1141402719b356686b86c47e4a159))
* **tests:** isolate real-tmux integration tests by construction, not ordering ([#277](https://github.com/gbasin/agentboard/issues/277)) ([9980106](https://github.com/gbasin/agentboard/commit/9980106b4101f8a98ad255fac3d10e48cf808ca1))

## [0.12.2](https://github.com/gbasin/agentboard/compare/v0.12.1...v0.12.2) (2026-09-22)


### Bug Fixes

* keep long-press context menu above sibling rows on iOS ([#270](https://github.com/gbasin/agentboard/issues/270)) ([b18750f](https://github.com/gbasin/agentboard/commit/b18750f638eb12981e3541ade3bc80bd0dd7a004))
* sync bun.lock optionalDeps with package.json 0.12.1 ([#272](https://github.com/gbasin/agentboard/issues/272)) ([4b8528f](https://github.com/gbasin/agentboard/commit/4b8528f65e5748a13cae5658347321defc9ee339))

## [0.12.1](https://github.com/gbasin/agentboard/compare/v0.12.0...v0.12.1) (2026-09-22)


### Bug Fixes

* pass repo to gh workflow run in release dispatch ([#267](https://github.com/gbasin/agentboard/issues/267)) ([6b9e769](https://github.com/gbasin/agentboard/commit/6b9e7698802b76bcd5ea306434c6fa10d5f08b68))
* unstick PR chip dots stuck gray after failed or abandoned info fetches ([#269](https://github.com/gbasin/agentboard/issues/269)) ([9b4fb59](https://github.com/gbasin/agentboard/commit/9b4fb59b93a958bef0feb69ded29e62932a2a5f0))

## [0.12.0](https://github.com/gbasin/agentboard/compare/v0.11.0...v0.12.0) (2026-09-22)


### Features

* sync optionalDependencies versions via release-please extra-files ([#259](https://github.com/gbasin/agentboard/issues/259)) ([9117ee9](https://github.com/gbasin/agentboard/commit/9117ee947de2e950e79c52b068c6c00f2921548a))


### Bug Fixes

* attach release assets via gh release upload ([#258](https://github.com/gbasin/agentboard/issues/258)) ([a0d9d55](https://github.com/gbasin/agentboard/commit/a0d9d554c5936df742a3cbee26b9dac474bdd003))
* dispatch release.yml instead of workflow_call for OIDC claims ([#254](https://github.com/gbasin/agentboard/issues/254)) ([de19f47](https://github.com/gbasin/agentboard/commit/de19f47e88b37e542bf8417558328ebb03acae38))
* grant workflows scope to release job for release updates ([#257](https://github.com/gbasin/agentboard/issues/257)) ([10431f2](https://github.com/gbasin/agentboard/commit/10431f2e175aad550bdc3e5a539c0092ec4ae540))
* keep PR chips on one row with width-aware +N overflow ([#260](https://github.com/gbasin/agentboard/issues/260)) ([c0a5dce](https://github.com/gbasin/agentboard/commit/c0a5dce7ccb01e73fa55ff0371c9c8ed2593aa7e))
* pass explicit tag to gh-release and make npm publish re-runnable ([#256](https://github.com/gbasin/agentboard/issues/256)) ([1c7f3da](https://github.com/gbasin/agentboard/commit/1c7f3daf3b5308c98ccdf35b03313df84bebdc81))
* render skipped CI checks as neutral instead of failed ([#263](https://github.com/gbasin/agentboard/issues/263)) ([85f9f87](https://github.com/gbasin/agentboard/commit/85f9f872c4122a275102410a40ceb974520dd46f))
* stop modal mount timers from stealing terminal focus ([#261](https://github.com/gbasin/agentboard/issues/261)) ([477ee62](https://github.com/gbasin/agentboard/commit/477ee62262a8d6149d8d7915d0eeac83cab66990))


### Performance Improvements

* bind HTTP server before initial session refresh ([#265](https://github.com/gbasin/agentboard/issues/265)) ([7474bf5](https://github.com/gbasin/agentboard/commit/7474bf524967de79c8489380bc642c6f3d4d5cc3))

## [0.11.0](https://github.com/gbasin/agentboard/compare/v0.10.4...v0.11.0) (2026-09-22)


### Features

* add oh-my-pi (omp) as a first-class agent ([#250](https://github.com/gbasin/agentboard/issues/250)) ([6cff6bb](https://github.com/gbasin/agentboard/commit/6cff6bb6e31f8992765625521cce39dc830fd14b))


### Bug Fixes

* append trailing space to Finder-copied file paths on paste ([#251](https://github.com/gbasin/agentboard/issues/251)) ([13d7b9b](https://github.com/gbasin/agentboard/commit/13d7b9b7ad85722d1adaffcaabf82079c2fa680f))
* drop extra-files jsonpaths from release-please config ([#252](https://github.com/gbasin/agentboard/issues/252)) ([aeec6bb](https://github.com/gbasin/agentboard/commit/aeec6bb4e94b7489daec4bdaf30b382500d3c92a))
