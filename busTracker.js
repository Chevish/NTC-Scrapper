import fs from 'fs';
import axios from 'axios';

const FROM_STAGE = 1505;
const TO_STAGE = 1406;

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

    console.log(`Job with id ${jobId} created.`);

    const intervalId = setInterval(() => pollingFn(...args), interval);
    jobs.set(jobId, intervalId);
}

const stopPollingJob = (jobId) => {
    if (!jobs.has(jobId)) {
        console.warn(`Job with id ${jobId} does not exist. Cannot stop non-existent job.`);
        return;
    }

    console.log(`Job with id ${jobId} stopped.`);

    const intervalId = jobs.get(jobId);
    clearInterval(intervalId);
    jobs.delete(jobId);
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
                    jobResult.get(jobId).coordinates.length >= 60 &&
                    jobResult.get(jobId).coordinates.slice(-60).every(c => c.Latitude === jobResult.get(jobId).coordinates.slice(-60)[0].Latitude && c.Longitude === jobResult.get(jobId).coordinates.slice(-600)[0].Longitude)
                )
            )
        )
    ) {
        stopPollingJob(jobId);

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

    jobResult.get(jobId).coordinates.push({ Latitude: TripCurrentLatitude, Longitude: TripCurrentLongitude });

    if (jobId === [...jobs.keys()][1]) {
        console.log(jobId, { Latitude: TripCurrentLatitude, Longitude: TripCurrentLongitude });
    }
}

const trackRoute = async (FromStageId, ToStageId) => {
    console.log(`Tracking ${FromStageId}-${ToStageId}`);
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
        const startTimeDt = new Date(StartTime);
        const now = new Date();

        const diffMinutes = (now - startTimeDt) / (1000 * 60);
        if (diffMinutes <= 2 && diffMinutes >= 0) {
            const jobId = [RouteId, JourneyTypeId, TripNumber, StartTime].join();
            const args = [jobId, RouteId, JourneyTypeId, TripNumber, VehicleId];
            createPollingJob(jobId, 5000, trackVehicle, args);
        }
    }

}

const main = () => {
    if (fs.existsSync("data/routesGeoloc.json")) {
        const routesGeolocJSON = fs.readFileSync("data/routesGeoloc.json", "utf-8");
        routesGeoloc = JSON.parse(routesGeolocJSON);
    }

    const args = [FROM_STAGE, TO_STAGE];
    createPollingJob(`trackRoute-${FROM_STAGE}-${TO_STAGE}`, 5000, trackRoute, args);
}

main();