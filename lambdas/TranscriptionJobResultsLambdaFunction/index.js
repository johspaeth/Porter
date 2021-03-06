// Once a transcribe job has completed and SendTaskSuccess has been sent, the
// job start state will complete, and this function is invoked next. It queries
// the results of the transcribe job, and generates a result with the
// information necessary for a Porter job callback. If this function is
// invoked, the transcribe job should always be done and have been successful.
// If the job wasn't successful, SendTaskFailure would have been called and
// the previous state would have failed.
// This function will also copy the transcript file from its artifact location
// to the destination defined on the Transcribe task.

const AWSXRay = require('aws-xray-sdk');

const AWS = AWSXRay.captureAWS(require('aws-sdk'));

const url = require('url');

const sts = new AWS.STS({ apiVersion: '2011-06-15' });
const transcribe = new AWS.TranscribeService({ apiVersion: '2017-10-26' });

// https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/S3.html#copyObject-property
// https://docs.aws.amazon.com/AmazonS3/latest/API/RESTObjectCOPY.html
// CopySource expects: "/sourcebucket/path/to/object.extension"
// CopySource expects "/sourcebucket/path/to/object.extension" to be URI-encoded
async function awsS3copyObject(event, transcriptionJob) {
  // e.g., https://s3.amazonaws.com/artifact-bucket/transcribe_job_name.json
  const fileUri = transcriptionJob.Transcript.TranscriptFileUri;
  const s3path = url.parse(fileUri).pathname;

  console.log(
    JSON.stringify({
      msg: 'S3 Copy',
      source: s3path,
      destination: `${event.Task.Destination.BucketName}/${event.Task.Destination.ObjectKey}`,
    }),
  );

  const role = await sts
    .assumeRole({
      RoleArn: process.env.S3_DESTINATION_WRITER_ROLE,
      RoleSessionName: 'porter_transcribe_task',
    })
    .promise();

  const s3 = new AWS.S3({
    apiVersion: '2006-03-01',
    accessKeyId: role.Credentials.AccessKeyId,
    secretAccessKey: role.Credentials.SecretAccessKey,
    sessionToken: role.Credentials.SessionToken,
  });

  const params = {
    CopySource: encodeURI(s3path),
    Bucket: event.Task.Destination.BucketName,
    Key: event.Task.Destination.ObjectKey,
  };

  const start = process.hrtime();
  await s3.copyObject(params).promise();
  const end = process.hrtime(start);

  console.log(
    JSON.stringify({
      msg: 'Finished S3 Copy',
      duration: `${end[0]} s ${end[1] / 1000000} ms`,
    }),
  );
}

exports.handler = async (event) => {
  console.log(JSON.stringify({ msg: 'State input', input: event }));

  // Get the details of the Transcribe job
  const res = await transcribe
    .getTranscriptionJob({
      TranscriptionJobName: event.TranscriptionJob.TranscriptionJobName,
    })
    .promise();

  const transcriptionJob = res.TranscriptionJob;

  if (event.Task.Destination.Mode === 'AWS/S3') {
    // TODO Detect if the source file is > 5 GB and do a multipart upload to
    // create the copy
    await awsS3copyObject(event, transcriptionJob);
  } else {
    throw new Error('Unexpected destination mode');
  }

  const now = new Date();

  return {
    Task: 'Transcribe',
    Mode: event.Task.Destination.Mode,
    BucketName: event.Task.Destination.BucketName,
    ObjectKey: event.Task.Destination.ObjectKey,
    Time: now.toISOString(),
    Timestamp: +now / 1000,
  };
};
