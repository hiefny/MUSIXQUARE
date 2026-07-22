declare const developerApiFacadeWorker: {
  fetch(request: Request, env: unknown): Promise<Response>;
};

export default developerApiFacadeWorker;
