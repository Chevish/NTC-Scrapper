import fs from 'fs';
import axios from 'axios';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

const argv = yargs(hideBin(process.argv))
    .option("r", {
        alias: "route-track-ms",
        type: "number",
        default: 10 * 1000 // 10 seconds 
    })
    .option("b", {
        alias: "bus-track-ms",
        type: "number",
        default: 5 * 1000 // 5 seconds 
    })
    .option("m", {
        alias: "max-runtime-ms",
        type: "number",
        default: 5 * 60 * 60 * 1000 // 5 hours 
    })
    .option("w", {
        alias: "bus-start-window-ms",
        type: "number",
        default: 2 * 60 * 1000 // 2 minutes 
    })
    .option("f", {
        alias: "from-id",
        type: "number"
    })
    .option("t", {
        alias: "to-id",
        type: "number"
    })
    .argv;

const START_TIME = Date.now();
const LAST_10_MIN_COUNT = Math.floor((10 * 60 * 1000) / argv.b);

const NTCService = axios.create({
    baseURL: "http://108.181.34.86/ntcservice/api/NtcController",
    headers: {
        "User-Agent": "Dart/3.3 (dart:io)",
        "Host": "108.181.34.86",
        "Accept-Encoding": "gzip, deflate, br",
        "Content-Type": "application/json; charset=utf-8",
    },
});


const jobs = new Map();
const jobResult = new Map();

const createPollingJob = (jobId, interval, pollingFn, args = {}) => {
    if (jobs.has(jobId)) {
        return;
    }

    console.log(`Job with id ${jobId} created.`);

    const intervalId = setInterval(() => pollingFn({ jobId, data: args }), interval);
    jobs.set(jobId, intervalId);
}

const stopPollingJob = (jobId) => {
    if (!jobs.has(jobId)) {
        console.warn(`Job with id ${jobId} does not exist. Cannot stop non-existent job.`);
        return false;
    }

    console.log(`Job with id ${jobId} stopped.`);

    const intervalId = jobs.get(jobId);
    clearInterval(intervalId);
    jobs.delete(jobId);

    return true;
}

const trackVehicle = async (args) => {
    const { jobId, data: { RouteId, JourneyTypeId, TripNumber, VehicleId, StartTime, FromStageId, ToStageId } } = args;

    let routeResponse;
    let vehicleResponse;

    try {
        routeResponse = await NTCService.post("/CustomerGetAllVehiclesByStages", {
            RequestData: {
                FromStageId,
                ToStageId
            }
        });

        vehicleResponse = await NTCService.post("/CustomerGetLiveVehicleTrack", {
            RequestData: {
                RouteId,
                JourneyTypeId,
                TripNumber,
                VehicleId
            }
        });
    }
    catch (error) {
        console.error(error);
    }

    if (
        !vehicleResponse?.data?.ResponseData ||
        !routeResponse?.data?.ResponseData ||
        !routeResponse.data.ResponseData.some((routeData) => jobId === [routeData.RouteId, routeData.JourneyTypeId, routeData.TripNumber, routeData.VehicleId, routeData.StartTime.replace(/:/g, '-')].join("_")) ||
        (
            jobResult.has(jobId) &&
            (
                vehicleResponse.data.ResponseData.VehicleStageDetails.at(-1).IsArrived ||
                (
                    jobResult.get(jobId).snapshots.length >= LAST_10_MIN_COUNT &&
                    jobResult.get(jobId).snapshots.slice(-LAST_10_MIN_COUNT).every(({ TripCurrentLatitude, TripCurrentLongitude }) => TripCurrentLatitude === jobResult.get(jobId).snapshots.slice(-LAST_10_MIN_COUNT)[0].TripCurrentLatitude && TripCurrentLongitude === jobResult.get(jobId).snapshots.slice(-LAST_10_MIN_COUNT)[0].TripCurrentLongitude)
                )
            )
        )
    ) {
        const jobStopped = stopPollingJob(jobId);
        if (!jobStopped || !jobResult.get(jobId)) {
            if (!jobResult.get(jobId)) {
                jobResult.delete(jobId);
            }

            return;
        }

        const routeInfo = jobResult.get(jobId);
        jobResult.delete(jobId);

        if (routeInfo.snapshots.length === 0) {
            return;
        }

        const direction = routeInfo.JourneyTypeId === 1 ? "outbound" : "inbound";
        const filePath = `data/routes/${routeInfo.RouteNumber}/${direction}`;

        fs.mkdirSync(filePath, { recursive: true });
        fs.writeFileSync(`${filePath}/${jobId}.json`, JSON.stringify(routeInfo));
        console.log("File created.", jobId);

        return;
    }

    vehicleResponse.data.ResponseData.TripCurrentDateTime = addHours(vehicleResponse.data.ResponseData.TripCurrentDateTime, 4);
    if (!jobResult.has(jobId)) {
        const stages = vehicleResponse.data.ResponseData.VehicleStageDetails.map(stage => {
            return {
                ...pick(stage, ["StageSLNumber", "StageId", "StageName", "StageCode"]),
                ActualDateTime: null,
                Longitude: null,
                Latitude: null,
                IsArrived: false
            }
        });

        const routeInfo = {
            ...omit(args.data, ["ExpectedTimeAtCurrentLocation", "ExpectedTimeAtDestinationLocation", "NumberOfPassenterInBus"]),
            ...pick(vehicleResponse.data.ResponseData, ["RouteNumber", "RouteName", "ServiceTypeId", "ServiceTypeName", "NumberOfBusStops", "VehicleCode", "VehicleMake"]),
            snapshots: [],
            stages
        };

        jobResult.set(jobId, routeInfo);
    }

    const { TripCurrentDateTime, TripCurrentLongitude, TripCurrentLatitude, VehicleStageDetails } = vehicleResponse.data.ResponseData;
    if (
        TripCurrentDateTime === addHours("1970-01-01T00:00:00", 4) ||
        (
            jobResult.get(jobId).snapshots.length > 1 &&
            jobResult.get(jobId).snapshots.at(-1).TripCurrentDateTime === TripCurrentDateTime &&
            jobResult.get(jobId).snapshots.at(-1).TripCurrentLongitude === TripCurrentLongitude &&
            jobResult.get(jobId).snapshots.at(-1).TripCurrentLatitude === TripCurrentLatitude
        )
    ) {
        return;
    }

    const currentStage = VehicleStageDetails.findLast(stage => stage.IsArrived);
    if (currentStage) {
        const stageToUpdate = jobResult.get(jobId).stages.find(stage => stage.StageId === currentStage.StageId);
        if (stageToUpdate && !stageToUpdate.IsArrived) {
            stageToUpdate.ActualDateTime = TripCurrentDateTime;
            stageToUpdate.Longitude = TripCurrentLongitude;
            stageToUpdate.Latitude = TripCurrentLatitude;
            stageToUpdate.IsArrived = true;
        }
    }

    jobResult.get(jobId).snapshots.push(pick(vehicleResponse.data.ResponseData, ["TripCurrentDateTime", "TripCurrentLongitude", "TripCurrentLatitude", "NumberOfSeatsAvailable", "CurrentLocation"]));
}

const trackRoute = async (args) => {
    const { jobId, data: { FromStageId, ToStageId } } = args;

    let response;
    try {
        response = await NTCService.post("/CustomerGetAllVehiclesByStages", {
            RequestData: {
                FromStageId,
                ToStageId
            }
        });
    }
    catch (error) {
        console.error(error);
    }

    if (!response?.data?.ResponseData) {
        return;
    }

    for (const routeData of response.data.ResponseData) {
        const { StartTime, RouteId, JourneyTypeId, TripNumber, VehicleId } = routeData;

        const startTimeDt = new Date(StartTime + "+04:00");
        const now = new Date();

        const diffMs = now - startTimeDt;
        if (diffMs <= argv.w && diffMs >= 0) {
            const jobId = [RouteId, JourneyTypeId, TripNumber, VehicleId, StartTime.replace(/:/g, '-')].join("_");
            createPollingJob(jobId, argv.b, trackVehicle, { ...routeData, FromStageId, ToStageId });
        }
    }

}

const addHours = (dtString, hours) => {
    const date = new Date(dtString);
    date.setHours(date.getHours() + hours);
    const pad = n => String(n).padStart(2, "0");

    return (
        date.getFullYear() + "-" +
        pad(date.getMonth() + 1) + "-" +
        pad(date.getDate()) + "T" +
        pad(date.getHours()) + ":" +
        pad(date.getMinutes()) + ":" +
        pad(date.getSeconds())
    );
}

const pick = (obj, keys) => {
    return keys.reduce((result, key) => {
        if (key in obj) {
            result[key] = obj[key];
        }

        return result;
    }, {});
}

const omit = (obj, keys) => {
    return Object.keys(obj).reduce((result, key) => {
        if (!keys.includes(key)) {
            result[key] = obj[key];
        }

        return result;
    }, {});
}

const main = () => {
    createPollingJob("max-timeout", Math.min(argv.m, 8 * 60 * 1000), () => {
        if (Date.now() - START_TIME > argv.m) {
            console.log("Max script runtime reached. Exiting gracefully.");
            jobs.keys().forEach(jobId => {
                stopPollingJob(jobId);
            });
        }
        else {
            console.log("Scrapper running...");
        }
    });

    if (argv.f && argv.t) {
        console.log(`Tracking manual route ${argv.f} - ${argv.t}`);
        const args = { FromStageId: argv.f, ToStageId: argv.t };
        createPollingJob(`trackRoute-${argv.f}-${argv.t}`, argv.r, trackRoute, args);

        return;
    }

    const coverageSetJSON = fs.readFileSync("data/minimumCoverageSet.json", "utf-8");
    const coverageSet = JSON.parse(coverageSetJSON);

    console.log(`No manual route specified. Tracking default minimum coverage routes.`);

    coverageSet.pairs.forEach(({ origin, destination }) => {
        const forwardArgs = { FromStageId: origin, ToStageId: destination };
        createPollingJob(`trackRoute-${origin}-${destination}`, argv.r, trackRoute, forwardArgs);

        const backwardArgs = { FromStageId: destination, ToStageId: origin };
        createPollingJob(`trackRoute-${destination}-${origin}`, argv.r, trackRoute, backwardArgs);
    });
}

main();
