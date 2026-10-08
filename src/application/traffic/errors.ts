export class JunctionNotFoundError extends Error {
    constructor(readonly junctionId: string) {
        super(`Junction "${junctionId}" does not exist`);
        this.name = "JunctionNotFoundError";
    }
}

export class JunctionAlreadyExistsError extends Error {
    constructor(readonly junctionId: string) {
        super(`Junction "${junctionId}" already exists`);
        this.name = "JunctionAlreadyExistsError";
    }
}

export class InvalidJunctionConfigError extends Error {
    constructor(readonly problems: string[]) {
        super(`Invalid junction configuration: ${problems.join("; ")}`);
        this.name = "InvalidJunctionConfigError";
    }
}

/** Another writer changed the junction between our read and our write. */
export class ConcurrencyError extends Error {
    constructor(readonly junctionId: string) {
        super(`Concurrent modification of junction "${junctionId}"`);
        this.name = "ConcurrencyError";
    }
}