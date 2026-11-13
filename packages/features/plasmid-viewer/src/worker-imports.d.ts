declare module '*?worker&inline' {
  const InlineWorkerConstructor: {
    new (): Worker;
  };
  export default InlineWorkerConstructor;
}
