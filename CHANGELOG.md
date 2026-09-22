# Changelog

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
