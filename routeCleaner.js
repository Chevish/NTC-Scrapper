import fs from "fs";

const main = async () => {
    const rawDataJSON = fs.readFileSync("data/routesRAW.json");
    const rawData = JSON.parse(rawDataJSON);

    const routes = rawData.reduce((acc, { RouteNumber, StartStage, EndStage, NumberOfStages, StageName, StageNumber }) => {
        NumberOfStages = Number(NumberOfStages);
        StageNumber = Number(StageNumber);

        const Stages = acc[RouteNumber]?.Stages ?? [];

        if (StageName !== "DO NOT USE" && !Stages.find(stage => stage.StageNumber === StageNumber)) {
            Stages.push({ StageNumber, StageName });
        }

        acc[RouteNumber] = {
            RouteNumber,
            StartStage,
            EndStage,
            NumberOfStages,
            Stages,
        }

        return acc;
    }, {});

    Object.values(routes).forEach(route => {
        route.Stages.sort((a, b) => a.StageNumber - b.StageNumber);

        if (route.Stages.length !== route.NumberOfStages) {
            console.warn(`⚠️  Route ${route.RouteNumber} expected ${route.NumberOfStages} stages but found ${route.Stages.length}.`);
        }

        if (route.Stages[0].StageName !== route.StartStage || route.Stages[route.Stages.length - 1].StageName !== route.EndStage) {
            console.warn(`⚠️  Route ${route.RouteNumber} start/end stage names do not match recorded names.`);
        }
    });

    fs.writeFileSync("data/routes.json", JSON.stringify(routes, null, 2));

    console.log(`✅ Cleaned data for ${Object.keys(routes).length} routes.`);
}

main();