export async function runCli(task,close=async()=>{}){
  try{await task();}
  catch(error){
    // Driver/DNS errors can include credentials or connection topology. Emit
    // only an allowlisted application message plus a numeric driver code.
    console.error('Command failed',{category:error.status?error.code:error.name,code:typeof error.code==='number'?error.code:undefined,...(error.status?{message:error.message}:{})});
    process.exitCode=1;
  }finally{try{await close();}catch{process.exitCode=1;}}
}
