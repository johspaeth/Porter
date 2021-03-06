// Starts a transcription job in Amazon Transcribe for the artifact. This is
// called with the waitForTaskToken pattern, so once the job has finished
// something (not this function), will need to send a SendTaskSuccess message
// with the provided task token for the execution to proceed.
// A file is written to the artifact store in S3 containing the task token.
// The object key matches the transcribe job name, so that it can be deduced
// from events generated by the job.
//
// Job names are given a prefix that is unique to this deployment of Porter.
// This is necessary becasue the CloudWatch Events rule that watches for
// transcription jobs will fire for *all* jobs, so there needs to be a way to
// filter out jobs originating elsewhere.
//
// The results of this state are defined by the parameters passed to
// SendTaskSuccess, NOT this function.
//
// https://docs.aws.amazon.com/transcribe/latest/dg/API_StartTranscriptionJob.html

const AWSXRay = require('aws-xray-sdk');

const AWS = AWSXRay.captureAWS(require('aws-sdk'));

const s3 = new AWS.S3({ apiVersion: '2006-03-01' });
const transcribe = new AWS.TranscribeService({ apiVersion: '2017-10-26' });

exports.handler = async (event) => {
  console.log(JSON.stringify({ msg: 'State input', input: event }));

  let mediaFormat = event.Artifact.Descriptor.Extension;

  // Remap some common types to the equivalent required value that the
  // Transcribe API expects
  if (mediaFormat === 'm4a') {
    mediaFormat = 'mp4';
  } else if (mediaFormat === '3ga') {
    mediaFormat = 'amr';
  } else if (mediaFormat === 'oga' || mediaFormat === 'opus') {
    mediaFormat = 'ogg';
  }

  // Take your life in your own hands, force a format
  if (event.Task.MediaFormat) {
    mediaFormat = event.Task.MediaFormat;
  }

  // Only start the job if the artifact type (or passed in MediaFormat) is supported
  if (
    !['mp3', 'mp4', 'wav', 'flac', 'ogg', 'amr', 'webm'].includes(mediaFormat)
  ) {
    throw new Error('Artifact format not supported');
  }

  // Should be unique, even if an execution includes multiple transcribe jobs
  const prefix = process.env.TRANSCODE_JOB_NAME_PREFIX;
  const transcriptionJobName = `${prefix}${event.Execution.Id.split(
    ':',
  ).pop()}-${event.TaskIteratorIndex}`;

  // Write the task token provided by the state machine context to S3
  await s3
    .putObject({
      Bucket: event.Artifact.BucketName,
      Key: `${transcriptionJobName}.TaskToken`,
      Body: event.TaskToken,
    })
    .promise();

  await transcribe
    .startTranscriptionJob({
      Media: {
        // https://docs.aws.amazon.com/transcribe/latest/dg/API_Media.html
        // Expects s3://<bucket-name>/<keyprefix>/<objectkey>
        MediaFileUri: `s3://${event.Artifact.BucketName}/${event.Artifact.ObjectKey}`,
      },
      TranscriptionJobName: transcriptionJobName,
      LanguageCode: event.Task.LanguageCode,
      // Valid Values: mp3 | mp4 | wav | flac | ogg | amr | webm
      MediaFormat: mediaFormat,
      OutputBucketName: event.Artifact.BucketName,
    })
    .promise();
};
