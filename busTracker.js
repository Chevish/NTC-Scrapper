import fs from 'fs';
import axios from 'axios';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

const argv = yargs(hideBin(process.argv))
  .option("r", {
        alias: "route-track-ms",
        type: "number",
        default: 5 * 1000 // 5 seconds 
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
  .argv;

const START_TIME = Date.now();
const LAST_10_MIN_COUNT = (10 * 60 * 1000) / argv.b;

const NTCService = axios.create({
    baseURL: "http://108.181.34.86/ntcservice/api/NtcController",
    headers: {
        "User-Agent": "Dart/3.3 (dart:io)",
        "Host": "108.181.34.86",
        "Connection": "keep-alive",
        "Accept-Encoding": "gzip, deflate, br",
        "Content-Type": "application/json; charset=utf-8",
    },
});


const jobs = new Map();
const jobResult = new Map();
let routesGeoloc = {};

const createPollingJob = (jobId, interval, pollingFn, args = []) => {
    if (jobs.has(jobId)) {
        return;
    }

    console.log(`Job with id ${jobId} created. Args: ${args}`);

    const intervalId = setInterval(() => pollingFn(...args), interval);
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

const trackVehicle = async (jobId, RouteId, JourneyTypeId, TripNumber, VehicleId) => {
    const response = await NTCService.post("/CustomerGetLiveVehicleTrack", {
        RequestData: {
            RouteId,
            JourneyTypeId,
            TripNumber,
            VehicleId
        }
    });

    if (
        !response.data.ResponseData ||
        (
            jobResult.has(jobId) &&
            (
                response.data.ResponseData.VehicleStageDetails.at(-1).IsArrived ||
                (
                    jobResult.get(jobId).coordinates.length >= LAST_10_MIN_COUNT &&
                    jobResult.get(jobId).coordinates.slice(-LAST_10_MIN_COUNT).every(([Latitude, Longitude]) => Latitude === jobResult.get(jobId).coordinates.slice(-LAST_10_MIN_COUNT)[0][0] && Longitude === jobResult.get(jobId).coordinates.slice(-LAST_10_MIN_COUNT)[0][1])
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

        const { routeNumber, coordinates } = jobResult.get(jobId);
        if (!routesGeoloc[routeNumber]) {
            routesGeoloc[routeNumber] = { Outbound: [], Inbound: [] };
        }

        const direction = JourneyTypeId === 1 ? "Outbound" : "Inbound";
        routesGeoloc[routeNumber][direction].push(coordinates);

        jobResult.delete(jobId);

        fs.writeFileSync("data/routesGeoloc.json", JSON.stringify(routesGeoloc, null, 2));
        console.log("File updated.", jobId);

        return;
    }

    const { RouteNumber, TripCurrentLatitude, TripCurrentLongitude, VehicleStageDetails } = response.data.ResponseData;
    if (!jobResult.has(jobId)) {
        jobResult.set(jobId, { routeNumber: RouteNumber, coordinates: [] });
    }

    jobResult.get(jobId).coordinates.push([TripCurrentLatitude, TripCurrentLongitude]);
}

const trackRoute = async (FromStageId, ToStageId) => {
    const response = await NTCService.post("/CustomerGetAllVehiclesByStages", {
        RequestData: {
            FromStageId,
            ToStageId
        }
    });

    if (!response.data.ResponseData) {
        return;
    }

    for (const { StartTime, RouteId, JourneyTypeId, TripNumber, VehicleId } of response.data.ResponseData) {
        const startTimeDt = new Date(StartTime + "+04:00");
        const now = new Date();

        const diffMs = now - startTimeDt;
        if (diffMs <= argv.w && diffMs >= 0) {
            const jobId = [RouteId, JourneyTypeId, TripNumber, StartTime].join();
            const args = [jobId, RouteId, JourneyTypeId, TripNumber, VehicleId];
            createPollingJob(jobId, argv.b, trackVehicle, args);
        }
    }

}

const main = () => {
    if (fs.existsSync("data/routesGeoloc.json")) {
        const routesGeolocJSON = fs.readFileSync("data/routesGeoloc.json", "utf-8");
        routesGeoloc = JSON.parse(routesGeolocJSON);
    }

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

    const coverageSetJSON = fs.readFileSync("data/minimumCoverageSet.json", "utf-8");
    const coverageSet = JSON.parse(coverageSetJSON);

    coverageSet.forEach(({ fromId, toId }) => {
        const args = [fromId, toId];
        createPollingJob(`trackRoute-${fromId}-${toId}`, argv.r, trackRoute, args);
    });
}

main();